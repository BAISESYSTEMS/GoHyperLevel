# Funnel & Website AI

Back to the [README](../README.md) · the website builder itself: [docs/sites.md](sites.md) (DE).

Describe what you need – "a landing page for my painting business in Cologne, goal: quote requests" – and the AI builds a **landing page, a funnel with steps or a multi-page website**: first a **page plan**, then the blocks of every page. Both answers are **checked against the blocks of the website builder** and the forms, calendars and products of your sub-account, you see a **preview and a list of what changes**, and the result is saved as a **draft only**: a new site is not public until you click *Veröffentlichen*, a change to an existing page lands in the editor as unsaved changes after a **restore point** was taken.

Inside the page builder an **AI side panel** works on the selected section or the whole page – "make this section shorter", "add an FAQ", "rewrite in du-Form" – and the same service writes **blog posts** and the text of **e-mail text blocks**. The same pipeline also drafts **custom AI agents** – see [docs/agent.md](agent.md#build-with-ai).

- [Creating a site with AI](#creating-a-site-with-ai)
- [The AI panel in the builder](#the-ai-panel-in-the-builder)
- [How the answer is checked](#how-the-answer-is-checked)
- [Drafts, restore points, undo](#drafts-restore-points-undo)
- [Model, cost and the monthly limit](#model-cost-and-the-monthly-limit)
- [AI writer](#ai-writer)
- [What is sent](#what-is-sent)
- [API and MCP](#api-and-mcp)
- [For developers](#for-developers)
- [Limits](#limits)

## Creating a site with AI

**Funnels & Websites → Mit KI erstellen.** The dialog is a short chat:

1. **Brief.** A greeting, suggestion chips (they fill in an example), radio cards for **what to build** (Landingpage – one page, one goal; Funnel – several steps; Website – several pages with a menu) and the **goal** (enquiries → form, appointments → calendar, sales → product & checkout, information → contact), your business, offer and audience, anything else that matters (prices, wanted pages or steps), **tone** (friendly, professional, casual, premium, bold), **du or Sie** and the **language (German or English)**. Below it: the estimated cost, the model and how much of this month's AI budget is used.
2. **Page plan.** The AI proposes the site's name, a design (one of the gallery templates' looks: colours, fonts, corners) and the pages with their building blocks. Rename or remove pages, then *Seiten schreiben*.
3. **Review.** Notes on what is still to do (calendar, product, company data, placeholders), the cost, and a **preview of every page** in the chosen design – forms and calendars show as examples.
4. **Als Entwurf anlegen.** The site is created **unpublished** with:
   - the design tokens, header, menu (websites) and footer of the chosen gallery look;
   - a **form** (name, e-mail, consent) when a page has one and it pointed at none of yours – after sending it leads to the thank-you page; your **calendar** in calendar blocks;
   - **Impressum and Datenschutz** (and **Widerruf** when something is sold) from the company data of *Einwilligung & Recht* – the same generator the templates use; without company data the pages keep a placeholder and the result says so.

The editor opens with a purple banner *KI-Entwurf – noch nicht öffentlich* and the button **Veröffentlichen**.

## The AI panel in the builder

**KI-Assistent** (purple button next to undo/redo) opens a side panel; ✕ or Esc closes it, the editor stays usable while it is open.

- **Scope:** *Abschnitt* (the section that holds what you selected in the structure) or *Ganze Seite*.
- **Suggestions** for a section: *Kürzer machen*, *FAQ hinzufügen*, *In Du-Form umschreiben*, *In Sie-Form umschreiben*, *Nutzen betonen*, *Aufruf ergänzen*; for the page: *Seite neu schreiben*, *Mehr Vertrauen*, *Kürzer & klarer*, *Alles in Du-Form*. Or type your own instruction (Ctrl/⌘ + Enter sends). Tone, du/Sie and language are radio cards.
- **Review:** the answer comes back as a proposal – the sections that are new, changed or removed (unchanged ones are counted), a preview of the changed sections in your site's design and the cost. *Übernehmen* first stores a **restore point**, then puts the result into the editor **unsaved**; *Speichern* makes it live. *Rückgängig* in the chat and the list of restore points bring the earlier state back into the editor.
- A section command only changes the selected section (and may add new ones after it). The section keeps its settings, and every block it keeps keeps its **styling** (colours, spacing, device settings) – only the texts change.

## How the answer is checked

The AI answers with JSON in a simple format – sections with a layout (`1`, `2`, `3`, `4`, `7-5`, `5-7`, `8-4`, `4-8` twelfths) and columns of blocks – which HyperLevel checks before you see anything:

- every **block type** must be in the AI schema **and** in the app's block registry (`siteBlocks(app)`): hero, heading, text, button, benefits, steps, numbers, testimonial, FAQ, pricing, call to action, form, calendar, product, divider, spacer. No images, videos or custom code – the AI cannot know real ones;
- **fields** are typed and limited (a hero heading ≤ 110 characters, an FAQ 2–10 entries …), choices must be one of the offered values, no HTML;
- **links** are `page:<path>` of a planned page, `#anchor`, `https://`, `mailto:` or `tel:`;
- **ids** of forms, calendars and products must exist in your sub-account – an invented id is an error; left empty, HyperLevel wires the right one;
- **one H1 per page**, every planned page exactly once, no legal pages (HyperLevel generates those), 1–2 pages for a landing page, 2–6 for a funnel, 2–8 for a website;
- unknown fields are removed (with a warning).

A failed check goes back to the AI with the list of problems – **up to three attempts**, like the [AI workflow builder](workflow-ai.md). After three failed attempts you get the problems and nothing is stored. The AI is told not to invent facts: unknown prices, numbers or quotes become placeholders in **[square brackets]**, testimonials are marked placeholders (publish only real ones).

## Drafts, restore points, undo

- **New sites are drafts.** While a site is an AI draft, every public address answers 404 – `/p/<site>`, its pages, deeper paths, `sitemap.xml`, a connected domain. The editor and its preview work as usual. *Veröffentlichen* (banner, or `POST /api/site-ai/drafts/:funnelId/publish`) takes it live; the audit log records who did.
- **Page and section changes never save themselves.** They land in the editor; the editor's own undo (Ctrl/⌘ + Z) works on them, and a **restore point** with the editor's state before the change is stored on the server (the last 20 per page, kept 30 days). Restoring puts it back into the editor (or, via the API with `save: true`, saves it – then the undo journal records that as a page edit).

## Model, cost and the monthly limit

The AI runs on the KI-Assistent of the sub-account (*Einstellungen → KI-Assistent*: Claude with your key, or OpenAI) – or on a connection of the **KI-Anbieter registry** routed to the use **"Funnel & Website AI"** (`sites`), falling back to quick texts (`text`); see [docs/ai-providers.md](ai-providers.md). Every request shows an **estimate** first (tokens by page count on the model's price), and is refused when the **monthly limit** of the KI-Assistent is reached or would not cover it. Every AI call is logged (purposes *Funnel & Website AI* and *KI-Texter*) and counts against the limit; a run shows its real cost. A site is two calls (plan, pages), plus retries.

## AI writer

**Mit KI schreiben** next to a blog post's content and **Text mit KI** in the e-mail designer's text block reuse the same service (model routing, estimate, limit, checks): topic, optional instruction, length (blog: about 400 / 800 / 1500 words), du/Sie, language, and – when there is text already – *Überarbeiten* or *Neu schreiben*. A blog post comes back as title, excerpt and Markdown (an empty title or excerpt is filled in); an e-mail text keeps merge fields like `{{contact.first_name|du}}`. *Übernehmen* puts it into the editor unsaved.

## What is sent

To the AI provider you chose: your brief or instruction, the block schema and the list of designs (the same for everybody), the **names and ids** of your forms, calendars and products (with prices), and – for builder commands – the outline of the page and the selected section's texts. **No contact data and no secrets.**

## API and MCP

Area `funnels`. All routes answer in German; `409` when the AI is off, has no key or the budget is used up, `422` after three failed attempts, `429` after 30 requests per hour per sub-account.

| Route | |
| --- | --- |
| `GET /api/site-ai/status` | `{ready, reason, provider: {label, model, byok}, budget, examples, options, commands, blocks}` |
| `POST /api/site-ai/estimate` | `{brief}` or `{mode: page\|section}` → `{usd, tokens, model, budget, fits, problem}` |
| `POST /api/site-ai/plan` | `{brief}` → `{plan, warnings, cost_usd}` – stage 1 only |
| `POST /api/site-ai/generate` | `{brief, plan?}` → `{run_id, plan, pages, notes, warnings, attempts, cost_usd, estimate_usd}`; a given plan skips stage 1 |
| `POST /api/site-ai/page` | `{page_id, prompt, brief?, current_blocks?}` → `{run_id, blocks, diff, summary}` – a whole page |
| `POST /api/site-ai/section` | `{page_id, section_id, command\|prompt, brief?, current_blocks?}` → `{run_id, blocks, diff, summary}`; commands `shorter`, `faq`, `du`, `sie`, `benefits`, `cta` |
| `GET /api/site-ai/runs`, `GET …/runs/:id`, `GET …/runs/:id/preview?page=` | History (30 days), the stored proposal, the proposal as HTML (sandboxed) |
| `POST /api/site-ai/runs/:id/apply` | Site runs: creates the unpublished site → `{funnel_id, url, draft: true, pages, wiring, legal, notes}`. Page/section runs: `{current_blocks}` → restore point + `{blocks, restore_point_id, diff}` (nothing saved) |
| `GET /api/site-ai/drafts`, `GET …/drafts/:funnelId`, `POST …/drafts/:funnelId/publish` | Unpublished AI sites, their state, publish |
| `GET /api/site-ai/restore-points?page_id=`, `GET …/restore-points/:id`, `POST …/restore-points/:id/restore` | Restore points of a page; restore returns the blocks (`save: true` saves them) |
| `POST /api/site-ai/write` | `{kind: blog\|email, topic, instruction?, current?, length?, address?, language?}` → `{title?, excerpt?, text}` |

**MCP tool `ghl_site_generate`:** `{location_id, prompt, page_type?, goal?, business?, offer?, audience?, tone?, address?, language?, pages?, apply?}` – returns plan, pages with their sections, notes and cost; with `apply: true` the site is created as an unpublished draft. The HyperLevel Agent knows it (a hint in its instructions: show plan and cost, apply only after the person agreed); its safety class is *write*.

## For developers

- `server/modules/site-ai.ts` (generation, runs, preview, apply, MCP, agent hint) and `site-ai-drafts.ts` (draft gate through `app.services.siteRedirect`, restore points, writer) – one registry line `...siteAiModules`.
- Pure logic: `services/site-ai-schema.ts` (block schema, `checkBlock`, `checkSection`, `compileSection`, `decompileSection`, `mergeSection`), `services/site-ai.ts` (brief, prompts, `checkPlan`, `checkPages`, section commands, `diffPage`, estimates, writer rules), `services/site-ai-kit.ts` (model info, budget, estimate, the ask-check-retry loop `askChecked`, also used by `modules/agent-ai.ts`).
- A new block type becomes available to the AI by adding it to `AI_BLOCKS` – it must also be in the block registry; a test checks the schema against the registry and the editor catalogue.
- Hooks: `app.services.siteAiDrafts` (`mark`, `isDraft`, `restorePoint`); purposes `site_builder` / `site_writer` in the AI usage log; BYOK use `sites`.
- UI: `web/src/pages/site/AiCreate.tsx`, `AiPanel.tsx` (panel + draft banner), `AiWriter.tsx`, `ai-kit.tsx`, `site-ai.css` (purple is reserved for AI accents); i18n namespace `siteai`.
- Tests: `tests/site-ai.test.ts` (the AI is a script behind the Claude API).

## Limits

- The AI writes text and structure, not pictures: add images, logos and videos yourself.
- The check guarantees a **valid** page, not a **true** one – read it, replace the placeholders, then publish.
- Legal pages are generated in German from your company data; for an English site check them.
- All routes, the writer included, belong to the area *Funnels & Websites*: a client login without that area does not get the writer in the e-mail designer either.
- Unsaved changes in the editor are part of a builder command (the editor sends them); a site created by the dialog starts from the brief only.
- Custom values (`{{custom_values.key}}`) in AI texts are filled on published pages like everywhere else ([docs/custom-values.md](custom-values.md)).
