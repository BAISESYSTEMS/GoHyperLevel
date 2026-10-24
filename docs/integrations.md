**English** · [Deutsch](integrations.de.md)

# Integrations: Zapier, Make, n8n, REST hooks, inbound webhooks, HubSpot migration, Lexware Office/sevDesk

Everything HubSpot users know from “Apps & integrations” – self-hosted, without a marketplace. Overview with live status:

- **Agency → Integrations → Catalog**: all built-in integrations (Stripe, Twilio, Meta/WhatsApp, Google/Microsoft, Google profile, Todoist, Postiz, OpenShorts (video studio), Norman, Supabase, Anthropic, ad accounts, SMTP/IMAP, MCP) plus Zapier, Make, n8n, REST hooks, inbound webhooks and the Umzug migrations from HubSpot/GHL – with search, categories, status (set up / incomplete / open / ready to use) and instructions. Per-sub-account integrations show “x of y sub-accounts set up”. The former settings cards are under **Setup**. Modules add their own entries, including a status probe, through `app.services.catalogExtra` (e.g. the video studio).
- **Sub-account → Apps**: the same catalog for the current sub-account. Client logins see agency settings only as “Set up by the agency”. Below the built-in integrations, matching apps from **Composio** (250+ apps with managed sign-in) appear; plus the tabs *Composio apps*, *App events*, *AI & MCP* and *Direct connections* (Slack/Discord, Notion, Google Sheets) – see [docs/connectors.md](connectors.md).

The status comes from the existing status endpoints (`GET /api/stripe`, `/api/telephony/settings`, `/api/settings/meta`, `/api/ai/settings`, `/api/ads/accounts`, `/api/agency/todoist`, …) – no external API is called. API: `GET /api/integrations/catalog` (sub-account), `GET /api/agency/integrations/catalog` (admins only).

## REST hooks

Instant triggers for automation tools following the REST hook pattern (as is usual with Zapier): the tool registers a target URL for a trigger, and HyperLevel sends every matching event there with a `POST`.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/hooks/me` | Test the connection (name/ID of the sub-account) |
| `GET /api/hooks/triggers` | Triggers with filters |
| `GET /api/hooks/triggers/:key/sample` | Sample data: the last three real events of the last 30 days, otherwise a template (GDPR erasure of a contact removes their samples and deliveries) |
| `POST /api/hooks` | Subscribe: `{target_url, event, filters?, source?, label?}` (`hookUrl`/`url`/`targetUrl` work too) → subscription with `id` and `secret` |
| `GET /api/hooks`, `GET/PATCH/DELETE /api/hooks/:id` | List, pause/resume (`{status: active\|paused}`), change filters, unsubscribe |
| `POST /api/hooks/:id/test` | Deliver a sample right away |
| `GET /api/hooks/deliveries`, `GET /api/hooks/deliveries/:id`, `POST /api/hooks/deliveries/:id/retry` | Delivery log (30 days), details with payload/response, resend |

**Triggers** (`event`): `contact.created`, `contact.updated`, `contact.tagged` (filter `tag`), `opportunity.created` (`pipeline_id`), `opportunity.stage_changed` (`pipeline_id`, `stage_id`), `opportunity.won`, `opportunity.lost` (`pipeline_id`), `form.submitted` (`form_id`), `appointment.booked`, `appointment.cancelled` (`calendar_id`), `invoice.paid`, `product.purchased` (`product_id`), `task.completed`, `message.inbound` (`channel`), `call.missed`, `review.received` (own, Google and [other platforms](reputation.md) – field `source`), `any` (all events, optionally `events: [...]`).

**Payload**: `{id, event, type, location_id, occurred_at, contact_id, contact, data}` – `id` is the same for each event (for deduplication), `contact` is the full contact, `data` the raw data (e.g. `data.opportunity`, `data.appointment`, `data.invoice`).

**Delivery**: header `x-pghl-signature = sha256(secret + body)` (as with the outgoing webhooks), plus `x-pghl-event`, `x-pghl-delivery`, `x-pghl-hook`, `x-pghl-attempt`. 2xx = delivered. Network errors, timeouts (10 s), 408, 429 and 5xx are retried: after 1 min, 5 min, 30 min, 2 h and 6 h (max. 6 attempts). Other 4xx are final. **410 Gone** three times in a row → the subscription is deactivated (reactivate it in the list). Targets in internal networks are blocked.

**Actions** (`POST /api/hooks/actions/<action>`, they run internally through the normal REST API with the same permissions, checks and log): `create_contact`, `update_contact` (by `contact_id`/`email`/`phone`, `new_email`), `add_tag`, `remove_tag`, `create_opportunity` (pipeline/stage by ID **or name**), `move_stage`, `create_task`, `add_note`, `send_message`, `create_invoice_draft` (`items: [{name, qty, price}]` in euros net or `price_cents`). If a contact isn't known by e-mail/phone, `add_tag`, `create_opportunity`, `create_task`, `add_note`, `send_message` and `create_invoice_draft` create it. **Searches**: `GET /api/hooks/search/contacts?email|phone|q|id`, `GET /api/hooks/search/opportunities?contact_id|email|status|q|id` (max. 10 each).

Sign-in: sub-account key (`pghl_…`, Settings → API & webhooks) or agency key (`pghla_…`) plus `x-location-id`. In the interface, **Settings → API & webhooks** shows subscriptions (source Zapier/Make/n8n/API, status, last response) and the delivery log.

## Zapier

A ready-made private app is in the repo: `integrations/zapier/` (Zapier Platform CLI). You decide yourself whether to upload it:

```bash
cd integrations/zapier && npm install && npx zapier login && npx zapier register "HyperLevel" && npx zapier push
```

Connection in Zapier: address (e.g. `https://crm.example.com`), API key, and for agency keys the sub-account ID. Included: all 17 triggers as instant triggers, the 10 actions, “Find contact (or create)”, “Find opportunity”, and dropdown lists for pipelines, stages, tags, forms, calendars, products. Details: [integrations/zapier/README.md](../integrations/zapier/README.md).

## Make

A custom app as JSON in `integrations/make/` (base, connection, dedicated webhook with attach/detach, instant trigger, actions, searches, RPCs). Create it in Make under **Custom Apps** and paste in the sections: [integrations/make/README.md](../integrations/make/README.md).

## n8n

Importable templates in `integrations/n8n/` (only webhook, HTTP request and manual trigger nodes): create a subscription, receive events, form → deal, deal won → invoice draft, lead from outside, missed call → callback. Access in n8n: header auth “HyperLevel API” with `Authorization: Bearer pghl_…`. [integrations/n8n/README.md](../integrations/n8n/README.md).

## Inbound webhooks

Workflow trigger **“Webhook received (with field mapping)”** (`webhook.received`) – for tools that can only “send a webhook to a URL” (shops, Typeform, Calendly, your own websites):

- Every workflow with this trigger gets a secret URL `https://<domain>/hooks/in/<token>` (copy it in the trigger, “New URL” invalidates the old one).
- The last five requests are saved as **test data** (for 30 days at most); “Wait for test data” shows new ones immediately. In **test mode** the request is only saved, the workflow doesn't start. If the workflow isn't active, the URL answers with 409 (test data is still saved). GDPR erasure of a contact removes test data containing their e-mail address or phone number.
- **Field mapping**: path in the JSON (`customer.email`, `items.0.sku`, `order[0].id`) → contact field, custom field (`custom.<key>`), tags or “Do not disturb”; “Map automatically” suggests fields by name, “Preview” shows the result without saving. Without a mapping, `email`, `phone`, `first_name`, `last_name`, `name`, `company` … and `tags` are read directly (or from `contact`). Plus fixed tags per workflow.
- The contact is created or merged by e-mail/phone, then the workflow starts; in the workflow the whole JSON is available as `{{webhook.…}}`.
- **Optional signature**: “Require signature” generates a secret (visible once, stored encrypted). Then every request must carry `X-Signature-256: sha256=<HMAC-SHA256 of the raw body, hex>` (also `X-Hub-Signature-256`, `X-Pghl-Hmac`, Base64 works too) – otherwise 401.
- **Limit** per URL: default 60 requests per minute (1–600), above that 429.
- **Retries**: if the sender includes a delivery ID (`webhook-id`, `svix-id`, `Idempotency-Key`, `X-Webhook-Id`, `X-Delivery-Id`, `X-GitHub-Delivery`, `X-Shopify-Webhook-Id` …), the same delivery starts the workflow only once (for 7 days); the retry gets `{ok: true, duplicate: true}`. Without an ID, every request counts.

API (login or key): `GET/PUT /api/inbound-webhooks/:workflowId` (`{mapping: [{from, to}], tags, capture, rate_limit}`), `POST …/secret` (`{enabled: false}` turns it off), `POST …/rotate`, `POST …/preview` (`{capture_id?, payload?, mapping?}`), `DELETE …/captures`. The classic trigger “Inbound webhook” (`/hooks/workflow/:id?key=`) recognizes retries by the same delivery IDs and rejects requests without e-mail, phone or name with 400 (otherwise empty contacts were created).

## HubSpot import

**Settings → Import → Move from HubSpot** brings a HubSpot account into the current sub-account.

1. In HubSpot: Settings → Integrations → **Private Apps** → “Create a private app”. Scopes (read): `crm.objects.contacts.read`, `crm.objects.companies.read`, `crm.objects.deals.read`, `crm.objects.owners.read`, `crm.schemas.contacts.read`, `crm.lists.read`, `tickets`, `sales-email-read`.
2. Enter the token (`pat-…`) – it is checked (`/account-info/v3/details`), stored **encrypted** and never shown again; “Disconnect” deletes it.
3. Choose parts and run a **dry run**: count per area in HubSpot, already imported, new.
4. **Start import**: runs in the background with progress per step and a log; “Pause” and “Resume” (also after errors or a server restart – it continues at the saved position).

| HubSpot | HyperLevel |
| --- | --- |
| Owner | User with the same e-mail (for “assigned to” on contacts, deals, tasks); without a match: a note in the log |
| Contact properties | custom fields (all you created yourself, plus job title, lifecycle stage, lead status, industry, state, mobile phone); select values as plain text |
| Contacts | contacts (name, e-mail, phone/mobile, company, address, website, birthday, creation date, source “HubSpot”); existing contacts with the same e-mail are merged |
| Companies | companies module, if installed (`app.services.companies`), otherwise the company name in the contact field “Company” |
| Deal pipelines + stages | pipelines with the same stages (your own stages added later are kept) |
| Deals | opportunities (value, stage, won/lost from the stage, owner); deals without a contact are counted and skipped |
| Notes | notes on the contact (HTML → text, original date) |
| Tasks | tasks (done/open, due date, owner) |
| Calls, e-mails, meetings | activities in the contact timeline (`hubspot.call` etc., original date) |
| Tickets | helpdesk module, if installed (`app.services.ticketsImport`), otherwise skipped with a note |
| Contact lists | tags with the list name |

Can run multiple times: every HubSpot ID is remembered (`hubspot_ids`), a second run updates instead of duplicating. Imported contacts trigger no workflows/webhooks. HubSpot limits: a short pause between calls; on 429, `Retry-After` is awaited (otherwise 1 s, 2 s, 4 s … up to 30 s, max. 6 attempts), the same for 5xx; after that the run aborts and can be resumed. If the scope for a part is missing (403), that part is skipped with a note.

API (only when signed in to the interface): `GET /api/import/hubspot` (connection without token, parts, last dry run and import), `PUT/DELETE /api/import/hubspot/connection` `{token}`, `POST /api/import/hubspot/dry-run` `{parts}`, `POST /api/import/hubspot/start` `{parts}` (parts: `owners, contacts, companies, deals, notes, tasks, engagements, tickets, lists`), `GET /api/import/hubspot/jobs[/:id]`, `POST /api/import/hubspot/jobs/:id/pause|resume`.

**For company/helpdesk modules** (a hook so the import uses them): `app.services.companies = { upsert(locationId, {name, domain, website, phone, address, city, postal_code, country, industry, external_source, external_id, existing_id}) → {id} | id, linkContact?(locationId, companyId, contactId) }` (alternatively `app.services.associations.link(locationId, {type:'company', id}, {type:'contact', id})`) and `app.services.ticketsImport(locationId, {external_source, external_id, existing_id, subject, content, pipeline, stage, priority, contact_id, assigned_to, created_at}) → {id} | id`.

<a id="lexware-office-and-sevdesk-live-sync"></a>
## Lexware Office and sevDesk: live sync

HyperLevel issues the invoice – gapless number, finalized document, PDF and XRechnung – and your accounting software automatically gets a copy. Before, there was only the one-off [Umzug](umzug.md) import and the manual link (`ghl_link_invoice`).

**Where:** sub-account → **Apps → Accounting** (also in the integration catalog as *Lexware Office (live sync)* / *sevDesk (live sync)*). One program per sub-account.

**Connect:**

| Program | What you enter | Where you get it |
| --- | --- | --- |
| Lexware Office (formerly lexoffice) | API key of the Public API | Lexware Office → *Settings → Extensions → Public API* (German: Einstellungen → Erweiterungen → Public API) → create a key (a plan with API access is required) |
| sevDesk | API token | sevDesk → *Settings → Users* (German: Einstellungen → Benutzer) → your user → *API token* |

The key is stored sealed (AES-256-GCM with the server key) and never returned to the browser – the page only shows `…abcd`. **Test connection** calls `GET /v1/profile` (Lexware) or `GET /SevUser` (sevDesk; the first user becomes the contact person on sevDesk invoices if you don't set one).

**What happens:**

1. An invoice or credit note is **finalized** (by hand, on payment, by a cancellation invoice, through Stripe, from a quote) – the event `invoice.finalised` puts it in the queue. One job per document and program: a repeated event, a manual transfer or a later change never creates a second job.
2. The **customer** is found or created in the program: first through the stored link, then through the customer number from a custom contact field (default key `customer_number` – the Umzug import fills it), then through the e-mail address, otherwise as a new customer (company with contact person, or person; billing address, e-mail, phone, VAT ID). In Lexware the *collective customer* can be used instead.
3. The **document**:
   - **Lexware Office:** an outgoing voucher (`POST /v1/vouchers`, type `salesinvoice` / `salescreditnote`) with HyperLevel's number as the voucher number, invoice, service and due date, one item per tax rate (net, tax, rate, posting category – default *Income* `8f8664a8-fd86-11e1-a21f-0800200c9a66`), after which HyperLevel's PDF is attached (`POST /v1/vouchers/{id}/files`). Lexware books the voucher but doesn't issue a second invoice. A final invoice is booked without the deducted down-payment invoices – those were already booked individually.
   - **sevDesk:** an invoice (`POST /Invoice/Factory/saveInvoice`) with HyperLevel's number, all items (net prices, tax rate, unit), the tax rule from HyperLevel's tax treatment (standard taxation → 1, export → 2, intra-community supply → 3, tax-exempt § 4 → 4, reverse charge → 5, small business § 19 → 11; the older `taxType` is sent along), invoice type `RE`/`TR`/`ER`, then *marked as sent* (`PUT /Invoice/{id}/sendBy` with `VPDF` – nothing is e-mailed). Credit notes and cancellation invoices become sevDesk credit notes (`POST /CreditNote/Factory/saveCreditNote`) with HyperLevel's number.
4. The ID in the program is stored in **`invoice_links`** (provider `lexware` / `sevdesk`) – the invoice list shows the badge, `ghl_list_invoices` returns it.
5. Every two hours (and with **Reconcile payments**), HyperLevel asks the program for **open linked invoices** (Lexware `GET /v1/payments/{id}`, sevDesk `GET /Invoice/{id}`). Whatever has come in there beyond what HyperLevel knows is recorded through the normal payment path (`recordPayment`, source `lexware` / `sevdesk`, date from the program): the invoice becomes *paid* or *partly paid*, `invoice.paid` starts workflows, the bookkeeping and – if turned on – the Google Ads offline conversion.

**Never twice:** besides the one job per document, the ID in the program is stored as soon as it exists (and the job remembers how far it got – created, PDF attached, marked as sent); a new attempt continues there instead of starting over. Before anything is created, HyperLevel searches the program for a document with the same number (`GET /v1/vouchers?voucherNumber=`, `GET /Invoice?invoiceNumber=`) and links it instead – that also covers a run that broke off between “created” and “stored”. An invoice that is already linked to another provider (e.g. Norman) is skipped.

**Limits and errors:** Lexware allows two requests per second and key; HyperLevel paces every call of a key accordingly (sevDesk: four per second). On `429`, `Retry-After` is awaited; `5xx` and dropped connections are retried three times with a wait within one run; after that a new attempt follows after 1 min, 5 min, 15 min, 1 h, 3 h, 6 h and 12 h, then the job stops. A rejected key (`401/403`) or a document rejected by the program (`400/406/422`) stops immediately. Everything lands in the **log** on the page; stopped jobs have **Try again**, and the catalog entry turns yellow as long as a job is failing.

**Older invoices:** **Transfer older invoices** queues finalized invoices from a date on that aren't linked anywhere yet (200 per click).

**Options (mapping):** customer matching (find or create / Lexware collective customer), custom field with the customer number, credit notes on/off, payment reconciliation on/off, Lexware: attach PDF, posting category; sevDesk: mark as sent, contact person (SevUser ID), unit ID. Turning *Transfer automatically* off pauses the sync without forgetting the key.

**Not (yet) included:** payments recorded in HyperLevel don't go to the program (book them there or let the bank import do it); a cash discount deducted in the program leaves the remainder open in HyperLevel; changes or deletions in the program don't come back; one program per sub-account. The integration follows both programs' public API documentation and is tested against mocks – first check one invoice, one credit note and one payment with a real account (especially the sevDesk e-mail search `GET /CommunicationWay`, the credit note fields and the Lexware posting categories for reverse charge / tax-exempt sales).

API (sub-account, area *Settings*): `GET /api/books-sync` (provider, options, status, counters – no key), `PUT /api/books-sync` `{provider: lexware|sevdesk, api_key?, enabled?, options?: {contact_match: auto|collective, customer_number_field, push_credit_notes, pull_payments, attach_pdf, category_id, mark_sent, sev_user_id, unity_id}}`, `DELETE /api/books-sync`, `POST /api/books-sync/test`, `GET /api/books-sync/jobs?status=`, `GET /api/books-sync/log`, `POST /api/books-sync/jobs/:id/retry`, `POST /api/books-sync/invoices/:id/push`, `POST /api/books-sync/backfill` `{since: YYYY-MM-DD}`, `POST /api/books-sync/pull`. Code: `server/modules/books-sync.ts` (queue, hooks, routes), `server/services/books-sync-model.ts` (payloads, pacing, waits), `server/services/books-sync-http.ts` (clients; test hooks `app.services.booksSyncFetch` / `booksSyncSleep`).

## OpenAPI & API reference

- `GET /api/openapi.json` – OpenAPI 3.1 of the public REST API and the REST hooks (including a `webhooks` section for the deliveries), e.g. for Postman, Insomnia, n8n or code generators.
- `GET /api/docs.html` – reference as a web page, rendered by us (no CDN, no script). `/api/docs` itself is already the projects' documents API, hence `.html`.

Both are generated from a hand-written route catalog (`server/services/openapi.ts`); a test checks that every documented path exists in the router.
