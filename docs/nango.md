# Nango: connectors with your own OAuth apps

[Nango](https://nango.dev) is a second connector backend next to [Composio](connectors.md). It handles
sign-in (OAuth, API keys, basic auth …) and token refresh for hundreds of APIs, and HyperLevel calls those
APIs through Nango's **Proxy**. Compared with Composio there is no vendor lock-in on the auth side: the
OAuth apps are yours, and Nango can run on your own server.

What sub-accounts get:

- the integrations configured in Nango in **Apps → Nango** and in the integrations catalogue, labelled
  **„via Nango“**, with **Verbinden**, status and **Trennen**;
- the workflow action **„API-Aufruf über Nango“** (method, path, query/body with merge fields,
  result mapping into contact fields);
- the MCP tool **`ghl_nango_request`** for Claude, Codex & co. and a `nango_request` tool for the
  HyperLevel Agent – both only within the sub-account's allow-list.

## Who sets up what

| Who | What | Where | How often |
| --- | --- | --- | --- |
| Agency admin | Nango account (Cloud) **or** self-hosted Nango | [nango.dev](https://app.nango.dev/signup) or [deploy/nango/](../deploy/nango/README.md) | once |
| Agency admin | One **integration per provider** with **your own OAuth app** (client id + secret, scopes). Nango does **not** provide managed OAuth apps – register the app at the provider (Google Cloud console, GitHub developer settings, HubSpot developer account …) with the callback URL Nango shows (`https://api.nango.dev/oauth/callback` or `<your-nango>/oauth/callback`). API-key providers need no app. | Nango dashboard → Integrations | once per provider |
| Agency admin | Nango address + **secret key** of the environment (e.g. `prod`); optional webhook signing key | HyperLevel: **Agentur → Integrationen → Einrichtung → Nango** | once |
| Users / sub-accounts | **Verbinden** on an integration, sign in at the provider | HyperLevel: **Apps → Nango** | per app |
| Users / sub-accounts | Optional: allow-list for AI & MCP, workflow steps | **Apps → Nango → Freigaben**, Automationen | as needed |

The secret key is sealed (AES-256-GCM with the data key) and never sent back to the browser; it can
also come from `PGHL_NANGO_SECRET_KEY` (+ `PGHL_NANGO_URL`, default Nango Cloud).

## Editions, licence, costs

- **Licence:** Nango is **Elastic License 2.0** – source-available, not OSI open source. HyperLevel ships no
  Nango code and only talks to its REST API. ELv2 forbids offering Nango itself as a hosted service to
  third parties; check the licence for your use.
- **Free self-hosted edition:** **Auth + Proxy** only – exactly what this connector needs. Syncs,
  actions, webhooks, triggers and Nango's MCP server need **Nango Cloud** or **Enterprise**.
- **Nango Cloud:** free tier and paid plans by connections/requests – see
  [nango.dev/pricing](https://nango.dev/pricing). HyperLevel logs every proxy call (**Apps → Nango → Letzte
  Aufrufe**) so you can see your usage.

## How it works

- **One Nango end user per sub-account:** `gohigh:<locationId>`. HyperLevel creates every connect session
  with `end_user.id = gohigh:<locationId>` (current Nango versions turn it into the tag
  `end_user_id`) and only accepts connections that carry this id – sub-accounts never see or use each
  other's connections, even though the secret key could reach all of them.
- **Verbinden = redirect, no popup:** HyperLevel creates a connect session limited to that one
  integration. For OAuth providers without extra fields the browser goes straight to
  `<nango>/oauth/connect/<integration>?connect_session_token=…` – plain redirects to the provider and
  back to Nango, no window opened by HyperLevel, so it works in the Android app (which opens external pages
  in a Custom Tab). Integrations that need input (API keys, a subdomain …) use Nango's hosted Connect
  UI (`connect_link`). Nango has no "return URL": after the sign-in Nango shows „Successful connection –
  you can close this window“. Back in HyperLevel (Back button, closing the tab), the page asks Nango once
  and shows the connection; **Aktualisieren** does the same at any time.
- **Webhooks (Cloud/Enterprise):** enter `https://<your-gohigh>/hooks/nango` as webhook URL in Nango and
  the signing key in HyperLevel. HyperLevel verifies `X-Nango-Hmac-Sha256` (HMAC-SHA256 of the raw body with the
  signing key; the secret key is also accepted, as older environments sign with it) and handles `auth`
  events: `creation`/`override` mark the connection active, `refresh` with `success: false` marks it
  „neu verbinden“, `deletion` removes it. Events for unknown end users are ignored.
- **Proxy calls** always use the connection id HyperLevel stored for that sub-account and integration –
  callers only name the integration, never a connection id. Paths must start with `/`, `..` segments,
  hosts and schemes are refused, credentials headers (`Authorization`, `Cookie`, `Connection-Id` …)
  can't be set (extra headers go out as `Nango-Proxy-*`), bodies are limited to 256 KB and answers to
  1 MB, 30 s timeout. The Nango base URL goes through HyperLevel's SSRF guard; a Nango instance in the
  internal network needs **„Internes Netz erlauben“** (agency only).

## Workflow action „API-Aufruf über Nango“

Pick the integration (a connected one), the method and the API path, e.g. `GET /user`,
`POST /crm/v3/objects/contacts` or `POST /repos/{{event.repo}}/issues`. Query parameters as
`a=1&b={{contact.email}}` or JSON, the body as JSON – merge fields work inside JSON strings
(`{"title": "Lead {{contact.name}}"}`, rendered after parsing so quotes in values can't break the
JSON). The answer is in the run log and available to later steps as `{{event.nango_result.status}}` /
`{{event.nango_result.data.<path>}}`; **Ergebnis übernehmen** maps values into contact or custom
fields. HTTP errors of the API (4xx/5xx) fail the step unless you untick that option.

## AI & MCP allow-list

**Apps → Nango → Freigaben** per connected integration: **Nur lesen (GET)** or **Alles**, optionally a
path pattern (`/repos/*`). It applies to API-key callers of `POST /api/nango/request`, the MCP tool
`ghl_nango_request` and the agent tool `nango_request`; workflows and signed-in users don't need it.
The allow-list itself can only be changed signed in (an API key can't widen its own access). When every rule is GET-only, the agent tool is marked read-only and runs without a confirmation;
otherwise the HyperLevel Agent asks before each call.

```json
{ "location_id": "<sub-account>", "mode": "integrations" }
{ "location_id": "<sub-account>", "mode": "request", "integration": "github", "method": "GET", "path": "/user/repos", "query": { "per_page": "5" } }
```

## Nango endpoints used

All requests go to the configured base URL with `Authorization: Bearer <secret key>`; the code is in
`server/services/nango.ts` (tests replace the network with `app.services.nangoFetch`).

| Purpose | Endpoint |
| --- | --- |
| Test, catalogue | `GET /integrations` → `{data: [{unique_key, display_name, provider, logo}]}` (no query parameters) |
| Direct OAuth or Connect UI | `GET /providers/{provider}` → `auth_mode`, `connection_config` (required fields) |
| Connect | `POST /connect/sessions` `{end_user: {id, display_name}, organization: {id, display_name}, allowed_integrations: [key]}` → `{data: {token, connect_link, expires_at}}`; browser to `<base>/oauth/connect/{key}?connect_session_token=…` or `connect_link` |
| Connections | `GET /connections?endUserId=gohigh:<loc>` → `{connections: [{connection_id, provider_config_key, provider, tags, end_user, errors}]}` |
| Disconnect | `DELETE /connections/{id}?provider_config_key=` (falls back to `DELETE /connection/{id}` on older instances) |
| Proxy | `{GET,POST,PUT,PATCH,DELETE} /proxy/{path}?query` with `Connection-Id`, `Provider-Config-Key`, `Nango-Proxy-<header>` |
| Webhook | `POST /hooks/nango` (HyperLevel), header `X-Nango-Hmac-Sha256` |

## What to verify with real keys

The connector was written against Nango's published OpenAPI spec and server sources (October 2026)
and tested against a mock; nobody has run it against a live Nango yet. Check once:

1. **`endUserId` filter** on `GET /connections` (deprecated in favour of `tags[end_user_id]` in current
   versions but still accepted). HyperLevel checks `tags.end_user_id` / `end_user.id` of every connection
   itself, so a server that ignores the filter is still safe – but very old versions without either
   field would show no connections.
2. **Direct OAuth URL** (`/oauth/connect/{key}?connect_session_token=`) for a Google/GitHub/HubSpot
   integration: the connection must appear after returning to HyperLevel. If a provider needs extra fields
   that `GET /providers/{provider}` doesn't list as required, the flow ends in an error at Nango – use
   the Connect UI by leaving that provider's fields optional or report it.
3. **Self-hosted `connect_link`**: it uses `NANGO_PUBLIC_CONNECT_URL`; if your version returns none,
   enter the Connect-UI address in HyperLevel.
4. **Webhook signing key**: send one test webhook from the Nango dashboard; HyperLevel answers 401 when the
   key does not match.
5. **Proxy errors**: Nango's own errors (`unknown_connection`, `connection_refresh_backoff` …) are
   shown as HyperLevel errors and mark the connection; any other non-2xx answer is the API's and is passed
   on as `{status, data}`.

## Troubleshooting

- *„Nango ist noch nicht eingerichtet“* – no address/secret key under Agentur → Integrationen and no
  `PGHL_NANGO_SECRET_KEY`.
- *„Der Nango-Secret-Key ist ungültig“* – wrong key or wrong environment (dev vs prod).
- *„Diese Integration ist in Nango nicht eingerichtet“* – create it in the Nango dashboard first.
- *„Die Nango-Adresse liegt in einem internen Netz“* – tick **Internes Netz erlauben** or use the public
  URL.
- *„… über github ist für KI & MCP nicht freigegeben“* – add a rule under Apps → Nango → Freigaben.
