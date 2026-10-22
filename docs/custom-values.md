# Custom Values

Back to the [README](../README.md).

Custom values are **global placeholders of a sub-account** – the phone hotline, opening hours, the booking link, this month's discount code. Store the value once under *Einstellungen → Custom Values* and write `{{custom_values.telefon_hotline}}` wherever merge fields work; change the value and every e-mail, SMS, workflow step, document and page that uses it changes with it. Agencies ship them in snapshots as **placeholders** and fill them per client.

- [Using them](#using-them)
- [Where they work](#where-they-work)
- [Snapshots: placeholders per client](#snapshots-placeholders-per-client)
- [Form target „Custom Value setzen“](#form-target-custom-value-setzen)
- [API and MCP](#api-and-mcp)
- [For developers](#for-developers)

## Using them

*Einstellungen → Custom Values*:

- **+ Neuer Wert:** a name („Telefon Hotline“), the **key** derived from it (`telefon_hotline` – lower case letters, digits and underscore, starting with a letter; up to 60 characters), the value (up to 5,000 characters), an optional **folder** („Kontakt“, „Aktionen“) and a **hint** that travels with snapshots. Up to 500 values per sub-account.
- The list groups by folder, has a search and a copy button for each placeholder. Edits and deletes go into the undo journal (*Verlauf*, Ctrl/⌘ + Z).
- **Ausprobieren** shows a text with placeholders the way this sub-account would send it.
- A fallback works like with every merge field: `{{custom_values.rabatt|kein Code}}`. An unknown key or empty value leaves nothing (and no stray space before a comma).

## Where they work

Everywhere the central template renderer (`core/template.ts`) fills merge fields: **e-mails and SMS** (campaigns, workflow steps, booking messages, sequences), **workflow steps** that take text (tasks, notes, webhooks, AI prompts …), **documents** (contracts and their e-mails, the e-mails of invoices) – the renderer finds the sub-account in the data it renders (`location`, the contact, the record) and asks for the value. **Published pages** of the website builder get them as the page leaves the server (escaped, so a value can never add markup); the editor's preview shows the placeholder itself.

Values are strictly per sub-account: the same key in two sub-accounts has two values, a workflow, page or document always uses the one of its own sub-account, and nobody can read or change another sub-account's values through the API or MCP.

Not covered: CMS detail templates (their `{{field}}` placeholders belong to the collection), the e-mail designer's merge-field menu (type the placeholder or copy it from the settings page).

## Snapshots: placeholders per client

A snapshot (*Agentur → Snapshots*, and *In anderen Kunden kopieren* for one website) carries the custom values as **placeholders**: key, name, folder and hint, **without the value** – unless a value is marked *Wert im Snapshot mitgeben* (for texts that are the same for every client). Copying one website takes only the values its pages use. After a client was created from the snapshot, *Custom Values* shows „N Werte aus einem Snapshot warten auf deinen Inhalt“ and marks them *Wert fehlt* until they are filled. Existing values of the target sub-account are never overwritten.

## Form target „Custom Value setzen“

A form field can overwrite a value when the form is sent – for example an internal form the team uses to set the promo code of the week. Choose the form, the field and the custom value under *Custom Values → Formular-Ziel*. Only text-like fields qualify (no files, signatures or payments); the value is cut to 5,000 characters. The input comes from whoever fills in the form – use it only for forms you control. Pages escape the value, HTML e-mails escape merge fields.

## API and MCP

Area `settings` (the list is readable for everyone in the sub-account; changes need the area).

| Route | |
| --- | --- |
| `GET /api/custom-values` | `{values: [{id, key, name, value, folder, description, in_snapshot, needs_value, placeholder}], folders, pending, limit}` |
| `POST /api/custom-values` | `{name, key?, value, folder?, description?, in_snapshot?}` – `409` when the key exists |
| `PATCH /api/custom-values/:id`, `DELETE /api/custom-values/:id` | Change (a new value clears *Wert fehlt*), delete |
| `PUT /api/custom-values/by-key/:key` | Upsert by key `{value, name?, folder?}` – for scripts and Zapier |
| `POST /api/custom-values/preview` | `{text}` → `{text, keys}` rendered for this sub-account |
| `GET /api/custom-values/form-targets`, `POST …/form-targets`, `DELETE …/form-targets/:id` | Form targets `{form_id, field_id, value_key}` |

**MCP:** `ghl_custom_values` (list, optional `folder`) and `ghl_custom_value_set` (`{location_id, key, value, name?, folder?}` – creates or updates by key).

## For developers

- `server/modules/custom-values.ts` (tables `custom_values`, `custom_value_form_targets`; routes; `pageServe` transform; snapshot part `custom_values`; undo entity `custom_value`; MCP), pure helpers in `server/services/custom-values.ts`.
- `core/template.ts` has a small namespace registry: `templateNamespace(name, (rest, data) => value | undefined)` is asked when the data has nothing under `name`. Custom values register `custom_values`; the resolver finds the sub-account with `locationOfData(data)` (`location.id`, `location_id`, `contact.location_id`, any record's `location_id`) and prefers the app the location row came from (several apps per process in tests). Data that brings its own `custom_values` wins.
- Tests: `tests/custom-values.test.ts` (resolution in workflows, documents and pages, isolation between sub-accounts, snapshots, form targets, MCP).
