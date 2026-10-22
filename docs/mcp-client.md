# External MCP servers (MCP client)

HyperLevel is an MCP **server** (`/mcp`, [api.md](api.md#mcp-server)) – and also an MCP **client**: an
admin adds any remote MCP server, HyperLevel reads its tools, the admin enables single tools, and HyperLevel
calls them server-side. This is the most general connector: everything that speaks MCP (GitHub,
Notion, Linear, Atlassian, Zapier, Make, Stripe, Supabase, Sentry, Cloudflare, a self-hosted
[AnythingMCP](https://github.com/HelpCode-ai/anythingmcp) gateway in front of your ERP …) becomes
available in

1. the workflow action **„MCP-Werkzeug ausführen“**,
2. the **HyperLevel Agent** (and every other consumer of `app.services.agentToolSources`),
3. optionally HyperLevel's own **`/mcp`**, re-exposed as `ext_<server>_<tool>` – one HyperLevel connection in
   Claude or Codex gives access to everything, scoped and logged by HyperLevel.

## Where

- **Agentur → MCP-Server** – servers for **all** or **selected** sub-accounts. Only here (and only
  agency admins) can **„Internes Netz erlauben“** be ticked.
- **Apps → MCP-Server** (sub-account) – own servers plus the agency's shared ones (read-only; a shared
  server that connects per sub-account or per user has its own „Verbinden“ there).

Each server: name, URL, transport, sign-in, tools checklist, switches **Im KI-Agenten** (default on)
and **Über HyperLevels /mcp** (default off), a try-out box and the log of the last calls.

## Presets

| Preset | URL | Sign-in | Docs |
| --- | --- | --- | --- |
| AnythingMCP (self-hosted, AGPL-3.0) | `https://<your-instance>/mcp` | token (or OAuth) – usually internal network | [github.com/HelpCode-ai/anythingmcp](https://github.com/HelpCode-ai/anythingmcp) |
| GitHub (official) | `https://api.githubcopilot.com/mcp/` | token (PAT); OAuth needs your own GitHub OAuth app (no DCR) | [github/github-mcp-server](https://github.com/github/github-mcp-server) |
| Notion | `https://mcp.notion.com/mcp` | **OAuth** (DCR) | [developers.notion.com/docs/mcp](https://developers.notion.com/docs/mcp) |
| Linear | `https://mcp.linear.app/mcp` | **OAuth** (DCR) or API key | [linear.app/docs/mcp](https://linear.app/docs/mcp) |
| Atlassian (Jira & Confluence) | `https://mcp.atlassian.com/v1/mcp` | **OAuth** (DCR) | [Atlassian Rovo MCP server](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/) |
| Zapier MCP | `https://mcp.zapier.com/api/v1/connect` | connection token | [docs.zapier.com/mcp](https://docs.zapier.com/mcp/get-started/connect/other) |
| Make MCP | `https://<zone>.make.com/mcp` | MCP token (OAuth via `https://mcp.make.com`) | [developers.make.com/mcp-server](https://developers.make.com/mcp-server) |
| Stripe MCP | `https://mcp.stripe.com` | restricted key `rk_…` (or OAuth) | [docs.stripe.com/mcp](https://docs.stripe.com/mcp) |
| Supabase MCP | `https://mcp.supabase.com/mcp?read_only=true` | **OAuth** (DCR) or PAT | [supabase.com/docs/guides/getting-started/mcp](https://supabase.com/docs/guides/getting-started/mcp) |
| Sentry | `https://mcp.sentry.dev/mcp` | **OAuth** (DCR) | [docs.sentry.io/product/sentry-mcp](https://docs.sentry.io/product/sentry-mcp/) |
| Cloudflare (docs) | `https://docs.mcp.cloudflare.com/mcp` | none (other Cloudflare servers: OAuth) | [developers.cloudflare.com](https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/) |

Vendors move endpoints – every preset links its docs; check them if a test fails. The presets live in
`server/services/mcp-presets.ts`.

## Transport

- **Streamable HTTP** (protocol 2025-06-18, also 2025-03-26): `POST` JSON-RPC with
  `Accept: application/json, text/event-stream`; JSON or SSE answers; `Mcp-Session-Id` and
  `MCP-Protocol-Version` on every request after `initialize`; `DELETE` ends the session.
- **HTTP+SSE fallback** (2024-11-05): when the POST is answered with 400/404/405 (or the transport is set
  to „SSE“), HyperLevel opens the event stream, waits for the `endpoint` event (same origin only) and posts
  the messages there.
- One session per operation (`initialize` → call → close). Server-initiated requests (sampling,
  elicitation) are not supported and ignored.

## Sign-in

- **None.**
- **Token / API key:** stored sealed (AES-256-GCM), shown only as „gespeichert …1234“. Header
  `Authorization` (HyperLevel adds `Bearer `) or any other header name (e.g. `X-API-Key`).
- **OAuth 2.1** (MCP authorization spec): HyperLevel probes the server, reads the
  **protected-resource metadata** (RFC 9728, from the 401's `resource_metadata` or
  `/.well-known/oauth-protected-resource[/path]`), then the **authorization-server metadata**
  (RFC 8414, OpenID Connect fallback; servers without metadata fall back to `/authorize`, `/token`,
  `/register` on the server's origin), registers itself with **dynamic client registration** (RFC 7591,
  public client) – or uses a client id/secret you enter – and sends the browser to the authorization
  endpoint with **PKCE S256**, `state` (signed, single use, bound to the login session) and the
  **resource indicator** (RFC 8707). The callback is `https://<your-gohigh>/mcp-client/oauth/callback`
  (enter it when you register an OAuth app by hand). Access and refresh tokens are sealed; HyperLevel
  refreshes them shortly before they expire and once after a 401 (rotating refresh tokens are handled;
  parallel refreshes are merged). A dead refresh token removes the connection and asks for „neu
  verbinden“. Servers that refuse S256 or publish non-https endpoints are refused.
- **Whose token:** *„Ein Zugang für alle“* (agency server: the agency connects once; sub-account server:
  the sub-account), *„Je Sub-Account“* (agency servers: every sub-account connects its own account) or
  *„Je Nutzer“* (every user their own – not usable in workflows or with API keys, which have no user).

## Tools and the allow-list

- **Testen** runs `initialize` + `tools/list` (paginated, up to 200 tools) and stores names,
  descriptions, input schemas and annotations. Calls use the stored schemas; the list is reloaded on
  „Testen“/„Neu laden“ (cached otherwise, so listing tools for the agent or `/mcp` never hits the
  server).
- Only **enabled** tools run – for every caller (workflow, agent, `/mcp`, REST). Arguments are rendered
  (merge fields) and checked against the tool's schema (required fields, types, enums) before the call.
- **Rug-pull protection:** each enabled tool is stored with a hash of its name, description and schema.
  When a reload shows a changed definition (or the tool is gone), HyperLevel switches it off and flags it
  „geändert – bitte prüfen“ until an admin enables it again.
- Tool names must match `[A-Za-z0-9_.-/]{1,128}`; descriptions are cut to 2000 characters and stripped of
  control/bidi characters; schemas above 16 KB are replaced by a generic object.

## Safety

- **SSRF:** every request (MCP calls, metadata, registration, token endpoint, SSE stream) goes through
  HyperLevel's guard (`safeFetch` / the same DNS check for the stream): private, loopback, link-local and
  metadata addresses are refused unless an **agency admin** ticked **„Internes Netz erlauben“** for that
  server. Tokens – also custom API-key headers – never follow a redirect to another origin. URLs are
  stored sealed (some, like Zapier's personal URLs, contain keys); the UI shows them masked.
- **Limits:** 30 s per request, 2 MB per answer, results handed on at most 100,000 characters (marked
  `truncated`), images/audio/binary resources are only named.
- **Results are data:** the agent gets them inside an `external_tool_result` envelope marked
  `untrusted`, wrapped again in `<tool_output trust="untrusted">`; a call to an external tool taints the
  run, so later sensitive actions need a confirmation. Tool descriptions get the prefix
  `[Externer MCP-Server „…“]`.
- **HyperLevel Agent classes:** an external tool is **read** only when the server marks it
  `readOnlyHint: true` (and not `destructiveHint`); everything else is **sensitive** („may write / goes
  outbound“) and follows the agent's confirmation rules („Vor Änderungen fragen“ always asks,
  „Autonom“ asks unless an admin switched confirmations off). Members without the automations area
  (`workflows`) get no external tools.
- **Configuration only signed in:** adding, changing or deleting servers and enabling tools needs a
  browser session – an API key or MCP client can use enabled tools but never widen its own access.
- **Log:** every call with source (`workflow`, `ai`, `mcp`, `api`, `ui`), duration, size and error –
  per server under „Letzte Aufrufe“ (30 days).

## Workflow action „MCP-Werkzeug ausführen“

Pick a server and one of its enabled tools; the form is built from the tool's input schema (required
fields first, merge fields everywhere). The result (structured content, else the text – parsed as JSON
when it is JSON) is in the run log and available as `{{event.mcp_result.data.<path>}}`;
**Ergebnis übernehmen** maps values into contact or custom fields. A tool answer with `isError` fails
the step.

## Re-exposure on HyperLevel's /mcp

With **Über HyperLevels /mcp** on, the enabled tools appear in `tools/list` of HyperLevel's MCP endpoint:

- **sub-account keys / OAuth tokens:** the servers available to that sub-account, as
  `ext_<server>_<tool>` with the original schema;
- **agency keys:** agency servers, with an extra required `location_id` (the server must be shared with
  that sub-account).

Calls are relayed onto `POST /api/mcp-servers/call` (same permissions, allow-list, audit and call log).
Names are `^[A-Za-z0-9_-]{1,64}$`; long or unusual tool names get a short hash suffix, and two servers
with the same name in one list get a short id in their prefix.

## Agent tool sources

`app.services.agentToolSources` is the generic hook through which modules give the HyperLevel Agent extra
tools (`server/services/agent-tool-sources.ts`):

```ts
type AgentToolSource = (ctx: { locationId: string; userId?: string }) => Promise<AgentTool[]>;

interface AgentTool {
  name: string;                 // ^[a-zA-Z0-9_-]{1,64}$, unique per run
  title?: string;               // label for confirmation cards
  description: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  input_schema: Record<string, unknown>; // JSON Schema, type object
  run(args: Record<string, unknown>): Promise<{ content: string; is_error?: boolean; data?: unknown }>;
}

// register
addAgentToolSource(app, async ({ locationId, userId }) => [...]);
// consume
const tools = await collectAgentTools(app, { locationId, userId });
```

Rules for sources: return only tools the sub-account (and user) may use right now; never throw from
`run` for tool-level failures (`is_error: true` instead); put third-party output into `content` as data
(`untrustedData(source, value)` builds the envelope); set `readOnlyHint` only when the tool really
can't change anything. The agent (`externalTools` in `server/services/agent-tools.ts`) adds them to its
catalogue per run (built-in tools win on name clashes), classifies them as described above and logs
them like every other tool. Sources today: external MCP servers (`ext_<server>_<tool>`) and Nango
(`nango_request`, [nango.md](nango.md)).

## API

See [api.md](api.md#external-mcp-servers-mcp-client). Test hook: `app.services.mcpClientFetch` replaces
`safeFetch` for buffered requests (the tests use real in-process MCP servers on 127.0.0.1 with
„internes Netz“ allowed).

## What to verify with real servers

Tested against in-test servers (bearer, legacy SSE, full OAuth 2.1 with DCR, PKCE, rotation). With real
vendors, check: that DCR works for Notion/Linear/Atlassian/Sentry/Supabase (some limit redirect URIs or
client names), that GitHub works with a PAT, Zapier/Make with their tokens, and whether a vendor's
`tools/list` exceeds 200 tools.
