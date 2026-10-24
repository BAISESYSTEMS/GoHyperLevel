**English** · [Deutsch](objects.de.md)

# Companies, custom objects, associations & lead scoring

The relational CRM as in HubSpot: besides contacts and deals there are **companies**, **custom objects** (e.g. vehicles, contracts, properties), **associations** between any records with labels, a **Properties** page for all fields, and **lead scoring**. There is nothing to set up and no credentials – everything runs on your own server.

## Companies

Menu **Companies** (under Contacts).

- **Fields:** name, domain, industry, size (1-10 … 1000+, a number is sorted into a bracket), phone, website, address/postcode/city/country, owner, lifecycle stage (subscriber, lead, MQL, SQL, opportunity, customer, evangelist, other), description – plus custom properties (see below).
- **No duplicates:** every domain exists only once. Creating a company with an existing domain updates the existing company (API, import, workflows). Duplicate companies (same name) are combined with **Merge** on the company page – contacts, deals, notes and empty fields move along.
- **Contacts ↔ companies:** many-to-many, with exactly one **primary company** per contact. The “Company” field on the contact always shows its name and so stays compatible with older features (placeholder `{{contact.company}}`, exports, Supabase):
  - If you type a company name on the contact (form, API, import), the company with that name becomes primary – if it doesn't exist, it is created (can be turned off).
  - If you clear the field, the association stays, only “primary” is dropped. If the primary association is removed or the company is deleted, the next company moves up (otherwise the field becomes empty).
  - Renaming a company changes the field on all contacts that have this company as primary.
  - Changes without an event (CSV import, workflow “Set field”) are picked up by the background job within a few minutes.
- **Automatically by e-mail domain:** contacts with `…@firma.de` are linked to the company `firma.de` (when the contact is created and when a company gets its domain) – never for free-mail addresses (gmail.com, web.de, gmx.de, t-online.de, outlook.com, icloud.com …). Optionally HyperLevel creates a company itself for unknown company domains. Settings are behind the gear icon in the company list (“Match all contacts now” then checks all contacts).
- **Deals:** new opportunities are linked to the primary company of their contact; further companies can be linked in the deal dialog.
- **Company page:** properties (by group), metrics (contacts, deal value excluding lost, open tasks), **activity** from company changes *and* all linked contacts, notes, tasks (they also appear under *Tasks*), all associations with labels.
- **List:** search, filters on every field (including custom properties, number of contacts/deals, deal value), choose and sort columns, **saved views** per user (optionally visible to the team), CSV import (columns are detected, same domain – otherwise same name – updates; files in UTF-8 or – as from Excel “CSV (comma delimited)” – Windows-1252) and CSV export.
- **Contact lists & smart lists** filter by properties of the linked companies (Contacts → “Company: …”), e.g. all contacts of companies in the industry “Software”; the filter becomes part of the smart list and so also of campaigns.

## Custom objects

Menu **Objects** shows all objects; custom objects are also listed directly below it in the sidebar.

- **Create an object:** name in singular and plural, icon, description and the **display property** (the name of a record in lists and associations, e.g. “License plate” – optionally unique). Further properties right in the same dialog or later. The internal name always starts with `p_` (e.g. `p_fahrzeuge`) and so never collides with types from other modules.
- **Properties** have a type: text, multi-line text, number, currency (€), date, date & time, select, multi-select, checkbox, URL, e-mail, phone, user, file (upload) – and optionally **required** and **unique**. Values are checked and normalized per type when saved (e.g. “1.234,50” → 1234.5, “03.10.2026” → 2026-10-03, “24.12.2026 18:00” → 6 pm in the sub-account's time zone, options case-insensitive; a day like 31 February does not exist).
- **Records:** list with search, filters (comparisons that fit each type), columns, sorting and saved views per user; record page with properties, activity (every change with old → new), notes and associations; CSV import (column headers = names of the properties, unique properties update instead of creating duplicates, errors with line number) and export.
- Deleting an object also removes its records, properties, views and associations (the interface asks first).

## Associations

Every record can be associated with any other: contacts, companies, deals, tasks, records of custom objects, helpdesk **tickets** – and types that other modules register. The **Associations** field appears on contact, company and record pages and in the deal dialog: search, associate, set labels, mark as primary, remove.

- **Labels** describe the relationship, e.g. contact ↔ company “Decision maker”, “Billing contact”, contact ↔ vehicle “Driver”. You create labels under *Properties* for the respective object; a deleted label disappears from all associations.
- If a record is deleted (contact, deal, task, company, record, also via a deleted sub-account or a deleted pipeline), its associations disappear automatically.
- The events `association.created` / `association.removed` go to webhooks.

## Properties

Menu **Objects → Properties** (or *Settings → Fields & tags → All properties*): one page for the custom fields of **contacts** (the existing custom fields – usable unchanged, now with group and description), **companies**, **deals** and every **custom object**.

- Arrange properties in **groups** (the groups structure the properties on company and record pages), label, type, options, description (help text under the field), required, unique. Standard properties are shown for reference.
- Contact properties offer the types the contact page supports (text, multi-line, number, date, select, checkbox, e-mail, phone, URL); there is no required/unique there.
- You edit **deal properties** in the pipeline's deal dialog.
- When you delete a property of companies, deals or objects, its values are removed; contact fields keep their values (as before). “Unique” can only be turned on if there are no duplicate values.

## Workflows

- **Triggers:** “Company created”, “Company updated”, “Company property changed” (property and optionally a new value, e.g. stage = `customer`), “Record (custom object) created/updated”, “Record property changed” (per object). Workflows run per contact – the **contacts associated with the record** are started, optionally only with a certain label (e.g. only “Decision maker”) or only those whose primary company it is. Placeholders: `{{event.company.name}}`, `{{event.company.custom.<key>}}`, `{{event.record.display}}`, `{{event.record.properties.<key>}}`, `{{event.property}}`, `{{event.value}}`.
- **Actions:** “Create company/record” (values with placeholders, company by domain without a duplicate, associate right away with the contact – with a label and as primary company), “Update company/record” (the record from the trigger, all records associated with the contact, or the primary company), “Associate records” (find via a property, e.g. company with domain = `{{contact.email}}` – e-mail addresses become the domain –, optionally create if none matches; or the record from the trigger).

## Lead scoring

Menu **Lead scoring** (Marketing). One or more **models** per sub-account; one is the **main score** (column, filter and sorting in the contact list).

- **Properties (fit):** points when a contact fits – contact fields (source, e-mail, city …), custom fields, tags, origin from attribution (first/last source, medium, campaign, number of visits) and **properties of the linked companies** (industry, size, stage, custom company properties). Comparisons: is, is not, contains, is empty/not empty, greater/less than.
- **Activity (engagement):** points per event – e-mail opened, link clicked, form submitted, page visit (attribution), appointment booked, message received (any channel or only chat, WhatsApp, SMS, e-mail reply), call held, deal created; per criterion optionally a **maximum of points** and a **period** (e.g. only clicks from the last 90 days). Earlier activity counts too (read from the existing data).
- **Negative points** subtract (free mail, competitor domain …); the score never drops below 0, and there is an optional **cap** (e.g. 100).
- **Decay:** e.g. −10% per 30 days without activity (last open, click, submission, booking, message …).
- **Thresholds** with names, e.g. MQL from 50, SQL from 80 – they appear as a label on the contact and in the list.
- **Recalculated** immediately on matching events (new tags, forms, clicks, appointments, messages, company changes …) and every night (decay, periods); “Recalculate” works at any time. After you change the rules, it is recalculated immediately.
- **On the contact:** score with threshold, breakdown per criterion and **history** (when, why, ▲/▼).
- **Contact list:** column “Score” (sortable), filter “Score: from MQL/SQL” – also in smart lists and so in campaigns. API: `GET /api/contacts?score_min=50`, `?score_label=SQL` (= SQL or higher), `?sort=score`.
- **Workflow triggers:** “Lead score reaches threshold” (model, threshold – only when rising above the threshold) and “Lead score changed” (rose/fell, minimum score); placeholders `{{event.score}}`, `{{event.label}}`, `{{event.previous}}`.

## Snapshots, Supabase, reports, import

- **Snapshots** include the **definitions**: custom objects, all properties with groups, groups/descriptions of the contact fields, association labels and lead scoring models – never companies, records or scores.
- **Supabase mirror:** additional tables `ghl_companies` (with `custom` as JSON), `ghl_object_records` (`object_type` = key such as `p_fahrzeuge`, `object_label`, `display`, `properties` as JSON) and `ghl_associations` (with label names). The SQL is, as usual, under *Agency → Integrations → Supabase mirror* (run it once more).
- **Reports:** data sources “Companies” (industry, size, stage, owner, city, created on, deal value total/won/open, number of contacts/deals, custom company properties), for each custom object a source “<plural> (object)” with its properties as groupings and metrics, and “Lead scores” (model, threshold, score, average score, share above a threshold, contact fields).
- **HubSpot import** (*Apps → HubSpot*): companies end up in this module (without duplicates even on a repeated import – via the HubSpot ID, otherwise the domain), their contacts are associated (first company = primary).

## Permissions

Companies, records, associations, views and scores belong to the area **Contacts & tasks**; creating/changing objects, properties, labels and scoring models needs **sub-account settings** (the lists can be read by everyone). “Read only” agency keys cannot change anything.

## API & MCP

All endpoints in [api.md](api.md#companies-objects--associations). MCP tools: `ghl_list_companies`, `ghl_upsert_company`, `ghl_list_object_types`, `ghl_search_records`, `ghl_upsert_record`, `ghl_associate`, `ghl_lead_score`.

```bash
# Create a company or update it by domain, and associate two contacts
curl -X POST https://crm.example.com/api/companies -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"name":"Muster GmbH","domain":"muster.de","industry":"Software","custom":{"tier":"A"},"contact_ids":["…","…"]}'

# Create a record of a custom object (unique property = no duplicate) and associate it with a contact
curl -X POST https://crm.example.com/api/objects/p_fahrzeuge/records -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"properties":{"name":"HH-AB 123","marke":"VW","kilometer":"12.000"},"associations":[{"type":"contact","id":"…","label":"Fahrer"}]}'

# Filter: companies in the software industry with more than €10,000 deal value, sorted by deal value descending
curl -G https://crm.example.com/api/companies -H "Authorization: Bearer $KEY" \
  --data-urlencode 'filters=[{"field":"industry","op":"eq","value":"Software"},{"field":"deals_value","op":"gt","value":10000}]' --data-urlencode 'sort=-deals_value'
```

## For developers: connecting other modules

- `app.services.associations` – `registerType({type, label, plural, icon, table, get(locationId, id) → {id, name, sub?, link?}, search?})` registers a record type of your own (with `table`, associations are removed automatically on delete), plus `link(loc, a, b, {labels, primary})`, `unlink`, `list(loc, ref, {type, label})`, `ids`, `primary`, `setPrimary`, `removeAll`, `onChange`. Helpdesk example: `registerType({ type: 'ticket', label: 'Ticket', plural: 'Tickets', table: 'tickets', get: … })`.
- `app.services.objectSchema` – properties per object (`defs`, `validate`, `createProperty`), activity and notes per record.
- `app.services.companies` – `upsert(loc, input)` → `{id, created, company}` (idempotent for imports with `external_source`/`external_id`), `linkContact`, `get`, `update`, `list`, `findByDomain`, `syncContact`; `app.services.customObjects` – `types`, `type`, `upsert`, `update`, `get`, `list`.
- New hooks in the core: `app.services.supabaseTables` (your own mirror tables with SQL), `app.services.workflowTriggerFilters` (filters for your own triggers), `app.services.contactSorts` (your own sort orders for the contact list).
