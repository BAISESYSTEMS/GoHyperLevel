# Connectors: Composio (250+ apps), Nango, external MCP servers and native connectors

HyperLevel connects to the tools your clients already use in four ways:

- **Composio** – one API key unlocks 250+ apps (Slack, Notion, Google Sheets/Drive/Docs, HubSpot, Salesforce, Pipedrive, Airtable, Asana, Trello, ClickUp, Jira, Linear, GitHub, Shopify, WooCommerce, Calendly, Typeform, Mailchimp, Discord, Zoom, Dropbox, Stripe …) with **managed sign-in**: Composio runs the OAuth flows and keeps the tokens. Use the apps as a workflow action, as a workflow trigger, from the AI assistant and from Claude/Codex over MCP.
- **Native connectors** – small direct integrations that need no Composio: Slack/Discord incoming webhooks, a Notion integration token, Google Sheets through the agency's Google OAuth app.
- **Nango** – hundreds of APIs with **your own OAuth apps** (Nango Cloud or self-hosted, Elastic License): the agency registers one OAuth app per provider in Nango once, sub-accounts only click „Verbinden“; calls go through Nango's Proxy. See [nango.md](nango.md).
- **External MCP servers** – any remote MCP server (GitHub, Notion, Linear, Atlassian, Zapier, Make, Stripe, Supabase, Sentry, Cloudflare, AnythingMCP …) as a tool source for workflows, the HyperLevel Agent and HyperLevel's own `/mcp`. See [mcp-client.md](mcp-client.md).

### Which one?

| | Composio | Nango | External MCP server | Native connector |
| --- | --- | --- | --- | --- |
| Keys the agency enters | one Composio project API key | Nango URL + secret key; **one OAuth app (client id/secret) per provider** in the Nango dashboard | per server: nothing, a token, or OAuth (usually automatic registration) | per sub-account: webhook URL / token; Google Sheets uses the agency's Google OAuth app |
| What users do | „Verbinden“ (Composio's hosted sign-in) | „Verbinden“ (redirect to the provider) | „Verbinden“ for OAuth servers, else nothing | enter the webhook/token |
| Managed OAuth apps | **yes** (Composio-managed for most apps) | **no** – your own apps (your branding, your quotas, no lock-in) | depends on the server (most remote servers handle OAuth themselves) | no |
| What you get | ready-made actions + triggers with schemas | raw API calls through the Proxy (any endpoint the API has) | the server's tools with schemas | a few fixed workflow steps |
| Workflows / AI / MCP | action + trigger / allow-list / `ghl_app_action` | action / allow-list / `ghl_nango_request` | action / enabled tools / re-exposed as `ext_<server>_<tool>` | steps only |
| Self-hosting | no (SaaS) | yes – free edition = Auth + Proxy | depends on the server (e.g. AnythingMCP) | n/a |
| Licence | proprietary SaaS | Elastic License 2.0 (source-available, not OSI) | per server (AnythingMCP: AGPL-3.0) | part of HyperLevel (AGPL-3.0) |
| Costs | free tier, then plans by tool calls | Cloud: free tier, then plans; self-hosted free edition: your server | per vendor (often included in the vendor's plan) | none beyond the service itself |

Everything lives in the sub-account under **Apps** (tabs *Katalog*, *Composio-Apps*, *App-Ereignisse*, *KI & MCP*, *Direkt-Verbindungen*, *Buchhaltung* – the Lexware Office / sevDesk live sync, see [integrations.md](integrations.md#lexware-office-and-sevdesk-live-sync) –, *Nango*, *MCP-Server*). The integrations catalogue shows native integrations, matching Composio apps and the integrations configured in Nango („via Nango“) side by side.

## Composio setup

1. Create an account at [composio.dev](https://composio.dev) and open your project.
2. **Settings → API Keys**: create a *project* API key.
3. In HyperLevel: **Agentur → Integrationen → Einrichtung → Composio (250+ Apps)**, paste the key, **Speichern**, then **Verbindung testen**. The key is sealed (AES-256-GCM with the server secret) and never sent back to the browser.
   - Alternatively set `PGHL_COMPOSIO_API_KEY` in the server environment.
   - A sub-account can use its **own** Composio project: *Apps → Composio-Apps → Eigenen Schlüssel für diesen Sub-Account*. Apps connected under one key do not work under another.
4. In a sub-account: *Apps → Composio-Apps*, search an app, **Verbinden**. The browser goes to Composio's hosted Connect Link, the user signs in at the app, and Composio sends the browser back to HyperLevel (`/composio/callback`).

**Costs.** Composio has a free tier with a monthly allowance of tool calls, and paid plans above it; check [composio.dev/pricing](https://composio.dev/pricing) for the current limits. HyperLevel logs every app action (*Apps → KI & MCP → Letzte Aufrufe*) so you can see what counts against your plan. AI agent steps additionally count against the sub-account's AI budget (KI-Assistent).

### How it works

- **One Composio user per sub-account**: `gohigh:<locationId>`. Connected accounts and triggers belong to that user, so sub-accounts never see each other's connections.
- **Auth configs**: when a sub-account connects an app for the first time, HyperLevel uses an enabled auth config of that toolkit (Composio-managed preferred) or creates one with Composio-managed auth. Apps without managed auth (some API-key apps, custom OAuth) need an auth config created once in the Composio dashboard – HyperLevel then picks it up.
- **Callback verification**: the callback carries a signed, single-use state bound to the login session and the sub-account. HyperLevel checks that the `connected_account_id` Composio reports is the one this attempt created, then reads the account from Composio (status, toolkit, user) before marking it *verbunden*. Composio's optional "callback identity verification" (project setting) is not needed for this.
- Statuses: *verbunden*, *wird verbunden*, *abgelaufen* (re-connect), *fehlgeschlagen*. **Aktualisieren** syncs them with Composio; an expired-account webhook marks them automatically.

## Workflow action „App-Aktion ausführen (Composio)“

Pick the app, search the action (e.g. *Send message*, *Create deal*, *Append row*), fill in the form. The form is built from the action's JSON schema: required fields first, the rest under *Weitere Felder*. Every text field takes merge fields (`{{contact.email}}`, `{{contact.custom.budget}}`, `{{event.total_price}}` …); right before the call HyperLevel renders them and converts values to the schema's types (numbers, yes/no, lists one per line or as JSON, objects as JSON) and checks required fields and allowed values.

- The result goes into the run log (*Verlauf*) and is available to later steps as `{{event.app_result.<path>}}`.
- **Ergebnis übernehmen** maps values from the result into contact fields or custom fields (`id` → `custom.hubspot_deal_id`).
- Errors (the app said no, missing connection, invalid input) appear in the run log; with *Bei Fehler stoppen* in the workflow settings the run stops there. Short outages at Composio (HTTP 429/502/503/504, lost connections) are retried twice with backoff; a write that timed out is not retried, so nothing runs twice.

## Workflow trigger „App-Ereignis (Composio)“

*Apps → App-Ereignisse → + App-Ereignis*: choose a connected app and one of its events (new Shopify order, new Typeform response, Calendly invitee created, new Stripe charge, new GitHub issue …), fill in its settings, optionally tags for the contact. Then create a workflow with the trigger **App-Ereignis (Composio)** (optionally limited to one subscription).

When the event fires:

1. Composio posts it to `https://<your-domain>/hooks/composio/agency` (or `/hooks/composio/<locationId>` for a sub-account with its own key). HyperLevel creates the project's webhook subscription itself on the first subscription; if the project already has one pointing elsewhere, each trigger gets a per-trigger delivery URL (`egress_url`) instead, so other uses of the project keep working.
2. HyperLevel verifies the signature (`webhook-signature: v1,<base64 HMAC-SHA256>` over `webhook-id.webhook-timestamp.body`, 5-minute window), drops repeated deliveries of the same `webhook-id`, and checks that the trigger belongs to that key and sub-account.
3. The contact is created or updated by e-mail/phone – found automatically (the first e-mail address, a phone number, names next to it) or through the field mapping (*Felder*, with preview). Events without e-mail or phone are logged as *ohne Kontakt*.
4. Workflows start with the payload as `{{event.*}}`, plus `{{event.app}}`, `{{event.trigger}}` and `{{event.subscriptionId}}`. Very large payloads are cut to their top-level values.

Composio can only reach a public **HTTPS** address – app events don't work on `http://localhost` (use a tunnel for testing).

## AI & MCP

*Apps → KI & MCP* holds the sub-account's **allow-list**: whole apps (`slack:*`) or single actions (`HUBSPOT_CREATE_DEAL`). Only these may be used by:

- **The AI assistant** – workflow step **KI-Agent mit Apps (Composio)** and the test box on the same page (`POST /api/composio/ai`). The agent runs on the KI-Assistent's `aiRun` (same model, key, monthly limit and log): each step is one structured Claude call that either searches allowed actions, executes one, or answers. At most six steps; anything outside the allow-list is refused before it reaches Composio.
- **MCP clients** (Claude, Codex, Cursor …) through HyperLevel's own MCP server at `/mcp` with the tool **`ghl_app_action`**:

```json
{ "location_id": "<sub-account>", "mode": "search", "query": "send a slack message" }
{ "location_id": "<sub-account>", "mode": "execute", "tool": "SLACK_SEND_MESSAGE", "arguments": { "channel": "#sales", "text": "New lead!" } }
{ "location_id": "<sub-account>", "mode": "connections" }
```

API-key callers of the REST endpoints (`/api/composio/tools`, `/api/composio/execute`) are held to the same allow-list; signed-in users in the app are not (they configure it). Workflow actions don't need an allow-list entry.

*Alternative:* Composio also offers hosted MCP URLs per user ("sessions", formerly Tool Router: `POST /api/v3.1/tool_router/session`). HyperLevel does not hand those out – `ghl_app_action` keeps the HyperLevel API key, the sub-account boundary, the allow-list and the call log in one place.

## Native connectors

All of them: *Apps → Direkt-Verbindungen*. Secrets are sealed and only shown as „gespeichert“.

| Connector | What you enter | Workflow step |
| --- | --- | --- |
| Slack | Incoming-webhook URL (`https://hooks.slack.com/services/…`, Slack → Apps → Incoming Webhooks) | „Benachrichtigung an Slack/Discord“ – title + text with merge fields; optional other channel URL |
| Discord | Webhook URL (`https://discord.com/api/webhooks/…`, channel → Integrations → Webhooks) | same step, service Discord (mentions are switched off) |
| Notion | Internal integration secret (`ntn_…`/`secret_…`, notion.so/my-integrations) and a default page shared with the integration | „Notion-Seite ergänzen“ – heading + paragraphs/bullets appended to the page (or another one) |
| Google Sheets | „Mit Google verbinden“ – uses the agency's Google OAuth app | export contacts (new spreadsheet or new tab, all contact and custom fields, optional tag filter), import contacts (first row = headers like *E-Mail, Vorname, Telefon, Firma, Tags* or custom field names; dry run; optional workflow start) |

Google Sheets needs, once per agency: the **Google Sheets API** enabled in the Google Cloud project of the OAuth app, and the extra redirect URI `https://<your-domain>/oauth/google/sheets/callback` added to the OAuth client. The connection asks for the `spreadsheets` scope (a sensitive scope – Google may require app verification before external users can grant it).

### Adding a native connector

A connector is one small module. It describes its fields, an optional connection test and its workflow actions; the framework (`server/modules/connectors.ts`) stores the values per sub-account (secret fields sealed), shows the form in *Direkt-Verbindungen*, adds a catalogue entry with live status and wires the actions into workflows.

```ts
// server/modules/connector-pushover.ts
import type { Module } from '../core/app.js';
import { render } from '../core/template.js';
import { connectorFetch, readJson, registerConnector } from '../services/connectors.js';

export const connectorPushoverModule: Module = {
  name: 'connector-pushover',
  register(app) {
    registerConnector(app, {
      key: 'pushover',
      name: 'Pushover',
      category: 'Kommunikation',
      icon: 'notify',
      description: 'Push-Nachrichten aufs Handy aus Workflows.',
      credentials: 'App-Token und User-Key unter Apps → Direkt-Verbindungen.',
      fields: [
        { key: 'token', label: 'App-Token', secret: true, required: true, pattern: /^\w{30}$/ },
        { key: 'user', label: 'User-Key', secret: true, required: true },
      ],
      steps: ['Pushover-Nachricht'],
      test: async (a, cfg) => {
        await readJson(await connectorFetch(a)('https://api.pushover.net/1/users/validate.json', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg) }), 'Pushover');
        return 'Verbunden';
      },
      actions: {
        pushover_send: async (a, cfg, _run, step, vars) => {
          const body = JSON.stringify({ ...cfg, message: render(String(step.text ?? ''), vars) });
          await readJson(await connectorFetch(a)('https://api.pushover.net/1/messages.json', { method: 'POST', headers: { 'content-type': 'application/json' }, body }), 'Pushover');
          return 'Pushover: gesendet';
        },
      },
    });
  },
};
```

Then add the module to `server/modules/index.ts` (next to the other connectors), a label in `STEP_LABELS` and a small step editor in `web/src/pages/Workflows.tsx`, and a test with `app.services.connectorFetch` mocked (see `tests/connectors-native.test.ts`). `connectorFetch` is `safeFetch` (no internal network targets, timeouts, size limit) unless a test replaces it. Connectors with their own setup (OAuth) set `custom: true` and a `probe` for the catalogue, like `connector-sheets.ts`.

## Native app steps (Slack bot, Teams, Trello … Zoom)

On top of the Slack/Discord webhooks, Notion and Google Sheets, there are 23 workflow steps for Slack (bot token), Microsoft Teams,
Trello, Asana, ClickUp, Airtable, Notion databases, Google Sheets rows, Google Calendar, HubSpot, Mailchimp, Brevo, Shopify,
WooCommerce, Stripe, Calendly, Typeform and Zoom. They are connectors in the sense above (`registerConnector`, credentials sealed
per sub-account, `safeFetch`), with two additions in `server/services/app-kit.ts`:

- `appCall(app, locationId, cfg, spec, req)` sends a request either **directly** (token/API key from the connection) or – when the
  connection names a **Nango integration** (`nango_integration`) and Nango is set up – through Nango's proxy, which owns OAuth.
  `AppSpec.nangoPrefix` is the path prefix the provider's API needs behind Nango's base URL.
- A connector action may return an `ActionOutcome` (variables, contact fields) instead of a string.

Credentials, behaviour and limits per app: [workflow-actions.md](workflow-actions.md#native-app-steps).

## Composio endpoints used

All requests go to `https://backend.composio.dev/api/v3.1` with the header `x-api-key: <project key>`; the code is in `server/services/composio.ts` (tests replace the network with `app.services.composioFetch`).

| Purpose | Endpoint |
| --- | --- |
| Test the key | `GET /auth_configs?limit=1`, `GET /webhook_subscriptions` |
| Catalogue | `GET /toolkits?search&category&cursor&limit&sort_by=usage`, `GET /toolkits/categories`, `GET /toolkits/{slug}` |
| Connect | `GET /auth_configs?toolkit_slug=`, `POST /auth_configs` `{toolkit: {slug}, auth_config: {type: "use_composio_managed_auth"}}`, `POST /connected_accounts/link` `{auth_config_id, user_id, callback_url}` → `{redirect_url, connected_account_id}` |
| Connections | `GET /connected_accounts?user_ids=`, `GET /connected_accounts/{id}`, `DELETE /connected_accounts/{id}` |
| Actions | `GET /tools?toolkit_slug&query&tool_slugs&limit`, `GET /tools/{slug}`, `POST /tools/execute/{slug}` `{user_id, connected_account_id, arguments}` → `{data, error, successful, log_id}` |
| App events | `GET /triggers_types?toolkit_slugs=`, `GET /triggers_types/{slug}`, `POST /trigger_instances/{slug}/upsert` `{user_id, connected_account_id, trigger_config, egress_url?}` → `{trigger_id}`, `PATCH /trigger_instances/manage/{id}` `{status: enable\|disable}`, `DELETE /trigger_instances/manage/{id}` |
| Webhook | `GET /webhook_subscriptions`, `POST /webhook_subscriptions` `{webhook_url, enabled_events: ["composio.trigger.message", "composio.connected_account.expired"], version: "V3"}`, `PATCH /webhook_subscriptions/{id}` `{enabled_events}` |

## What to verify with a real key

The integration was written against Composio's published OpenAPI spec (Platform API v3.1) and SDK sources and tested against a mock; nobody has run it against a live Composio project yet. Check these points once with a real key:

1. **Array query parameters** (`user_ids`, `toolkit_slugs`) are sent as repeated keys (`?user_ids=a`); HyperLevel only ever sends one value, but the encoding is an assumption.
2. **Managed auth config creation** for a toolkit with no config yet (`POST /auth_configs` with `use_composio_managed_auth`) – and the error Composio returns for toolkits without managed auth (HyperLevel shows a hint on HTTP 400).
3. **Callback parameters**: Composio appends `status=success|failed&connected_account_id=…` to the callback URL (documented; the SDK's `initiate()` variant uses camelCase `connectedAccountId`, which HyperLevel also accepts).
4. **Webhook secret**: HyperLevel reads `secret` from the webhook-subscription responses and keys the HMAC with it as UTF-8 (as Composio's SDK does). If the dashboard shows a different secret format, verify one real delivery.
5. **`egress_url`** on trigger upsert is only sent when the project's subscription points somewhere else; confirm your plan supports it.
6. **Execute response**: failures inside the app come back as HTTP 200 with `successful: false` and `error` – HyperLevel shows that error in the run log.
7. **Trigger payloads**: the contact finder expects the e-mail somewhere in `data` (V3). Check the payload of the triggers you use in *App-Ereignisse → Protokoll → Daten* and add a field mapping where needed.

## Troubleshooting

- *„Composio ist noch nicht eingerichtet“* – no agency key, no sub-account key and no `PGHL_COMPOSIO_API_KEY`.
- *„Der Composio-API-Schlüssel ist ungültig“* – the key was revoked or belongs to another project.
- *„… ist in diesem Sub-Account nicht verbunden“* – connect the app under *Apps → Composio-Apps* (or re-connect an expired one). Connections made with another key don't count.
- App events don't arrive – the server must be reachable over HTTPS; *App-Ereignisse → Protokoll* lists every delivery (ignored ones with a reason). A signature error after rotating the secret in Composio fixes itself: HyperLevel fetches the secret again (at most every 5 minutes).
- *„… ist für KI & MCP nicht freigegeben“* – add the action or the whole app under *Apps → KI & MCP*.
