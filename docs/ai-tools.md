# AI tools: Codex, Claude Code, Cursor, ChatGPT and Claude.ai

HyperLevel has an [MCP server](api.md#mcp-server) at `https://<your-domain>/mcp`. Any MCP client can use it to work with your CRM: projects, contacts, companies, deals, tasks, the inbox, social posts, blog drafts, reports and more (340+ tools, all prefixed `ghl_`, plus `ghl_api` for every other route – see [ghl_api](#ghl_api-every-app-function)). Every change goes through the regular REST API, so permissions, validation and the audit log apply (path "MCP").

There are two ways to connect:

| | How | Good for |
| --- | --- | --- |
| **API key** | A key per tool and device, created with one click, sent as `Authorization: Bearer …` | Codex CLI and IDE extension, Claude Code, Cursor, scripts |
| **OAuth** | The app opens the HyperLevel login, you pick the sub-account and allow access – no key to copy | ChatGPT (developer mode connectors), Claude.ai / Claude Desktop custom connectors, `codex mcp login`, Claude Code |

## Where

- **Settings → KI-Werkzeuge** (per sub-account): for everyone with the *Einstellungen* (settings) area – also client logins. Keys created here are always **sub-account keys** (`pghl_…`): they only reach this one sub-account. A client login can never get an agency key.
- **Agency → KI-Werkzeuge** (admins only): **agency keys** (`pghla_…`, "read only" or "read & write") for all sub-accounts, agency-wide OAuth connections and the default AI provider of the [AI assistant](ai-assistant.md#ai-provider-anthropic-or-openai).

The page shows your exact MCP address, copy-paste setup for every tool (with the new key filled in), a connection test, all keys with "last used", and the apps connected via OAuth. Keys and connections can be revoked there at any time – access ends immediately.

## Create a key

1. Settings → KI-Werkzeuge → pick the tool (Codex, Claude Code, Cursor, other) and a device name, e.g. "Laptop".
2. **Schlüssel erzeugen** creates a key named "Codex – Laptop". It is shown **only once** – set it up right away or store it in your password manager.
3. **Verbindung testen** runs a real MCP `initialize` + `tools/list` against your instance with that key, exactly like Codex or Claude Code would, and shows the server, protocol version and number of tools.

HyperLevel stores only a SHA-256 hash of each key.

## Codex (CLI and IDE extension)

The Codex CLI and the Codex extension for VS Code, Cursor & co. share `~/.codex/config.toml`:

```toml
# ~/.codex/config.toml
[mcp_servers.gohigh]
url = "https://<your-domain>/mcp"
bearer_token_env_var = "GOHIGH_API_KEY"
```

```bash
# e.g. in ~/.zshrc or ~/.bashrc
export GOHIGH_API_KEY="pghl_…"
```

The same with one command:

```bash
codex mcp add gohigh --url https://<your-domain>/mcp --bearer-token-env-var GOHIGH_API_KEY
```

Without a key, Codex can sign in via OAuth (dynamic client registration + PKCE, the HyperLevel consent screen opens in the browser):

```bash
codex mcp add gohigh --url https://<your-domain>/mcp
codex mcp login gohigh
```

Check with `codex mcp list`, then ask Codex e.g. "Which tasks are open in HyperLevel?".

> The format was checked against the [openai/codex](https://github.com/openai/codex) source (`codex-rs/config/src/mcp_types.rs`, `codex-rs/cli/src/mcp_cmd.rs`): streamable HTTP servers take `url` plus `bearer_token_env_var` (alternatively `http_headers` / `env_http_headers`); `codex mcp add <name> --url <url> --bearer-token-env-var <VAR>` writes the same entry; `codex mcp login <name>` does the OAuth flow. The full reference lives at developers.openai.com/codex (config reference).

## Claude Code

```bash
claude mcp add --transport http gohigh https://<your-domain>/mcp --header "Authorization: Bearer pghl_…"
```

With `--scope project` the server is written to the repository's `.mcp.json` – then don't commit the key. Without `--header`, Claude Code signs in via OAuth (`/mcp` → Authenticate).

## Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "gohigh": {
      "url": "https://<your-domain>/mcp",
      "headers": { "Authorization": "Bearer pghl_…" }
    }
  }
}
```

Then enable "gohigh" under Cursor Settings → MCP.

## ChatGPT (connectors / apps, developer mode)

1. ChatGPT → Settings → **Apps & Connectors** → Advanced → turn on **Developer mode** (availability depends on your ChatGPT plan).
2. **Create**: name "HyperLevel", MCP server URL `https://<your-domain>/mcp`, authentication **OAuth**. No client ID or secret – ChatGPT registers itself (RFC 7591).
3. ChatGPT opens the HyperLevel login: sign in, choose the sub-account (admins can also choose the whole agency), choose "read & write" or "read only", **Zulassen** (allow).
4. In a chat, pick the connector via "+" → Developer mode.

## Claude.ai and Claude Desktop (custom connectors)

1. Claude → Settings → **Connectors** → **Add custom connector**.
2. Name "HyperLevel", URL `https://<your-domain>/mcp`, leave OAuth client ID/secret empty.
3. **Connect** → HyperLevel login → choose sub-account (or agency) → allow.
4. Enable the connector in a chat under "Search and tools".

## Claude-Projekte umziehen

Move your Claude work into HyperLevel – one sub-account per project, with its instructions, knowledge files and chat links:

1. **Connect with agency scope.** Add the custom connector as above; on the consent screen (`/app/oauth-consent`) sign in as an
   admin, pick **Ganze Agentur** (agency) and **read & write**. Only an agency connection sees `ghl_import_claude_project`.
2. **claude.ai Projects.** Open the project in claude.ai and ask, for example: *"Call ghl_import_claude_project with this project's
   name, its instructions and description, every knowledge file (path + content) and links to the chats and artifacts that matter."*
   The tool finds the sub-account with exactly that name or creates it, stores the instructions as `CLAUDE.md` (and in the profile's
   notes when they are empty), the knowledge files as [project files](#project-files) (source `claude-project`) and the links under
   *Berichte & Artefakte*. Running it again with the same input changes nothing – files are matched by path, links by URL, and notes
   you wrote yourself are never overwritten. Binary files go as Base64 (`data`); one MCP call can be about 12 MB, so hand in big
   knowledge bases in several `ghl_upload_files` calls afterwards.
3. **Claude Desktop / Claude Code repos.** In the repository ask: *"Upload the files that matter for this project (README, CLAUDE.md,
   docs/, the main config) with ghl_upload_files to sub-account X, source claude-code."* Paths stay as they are in the repo
   (`docs/plan.md`); a later upload of the same path replaces the file, unchanged files stay as they are. Link the session itself with
   `ghl_update_project` (`claude_sessions`).

The result lands in **Projekt → Dateien** (path, size, last change, download, delete) next to *Berichte & Artefakte*.

## Project files

Every sub-account has a small file store for whatever belongs to a project: text and binary, up to **10 MB per file**, **200 files
and 25 MB per call**, and `PGHL_PROJECT_FILES_MB` per sub-account (default 1024 MB, `0` = no cap of its own; in the hosted cloud the
files also count against the plan's media storage). Paths are relative and normalised (`./a//b` → `a/b`); absolute drive paths, empty
segments and `..` are refused. Downloads are always attachments with `nosniff` and a sandbox CSP – an uploaded HTML or SVG file never
runs on your domain. Who may see them: logins with the *Einstellungen* area of the sub-account, its keys and MCP connections.

MCP tools: `ghl_upload_files` (`files: [{path, content}` or `{path, data: Base64}, mime?]`, `source`), `ghl_list_files` (`prefix`),
`ghl_read_file` (metadata, plus the text of text files up to 1 MB), `ghl_delete_file`. REST: [docs/api.md](api.md#project-files).

## ghl_api: every app function

`ghl_api` calls any REST route of HyperLevel – everything there is no dedicated tool for: `{method: GET|POST|PUT|PATCH|DELETE,
path: "/api/…", location_id?, body?}`. `ghl_api_routes` `{query?, method?, module?, limit?}` finds the route first – live from the router,
so every module (also future ones) is in it, with the API reference's short description and the area a login needs (e.g. "formular
einsendungen" → `GET /api/forms/:id/submissions`); denied routes never show up. It runs with the connection's own rights and nothing more: a sub-account key or connection
stays in its sub-account, a read-only connection can only `GET`, an agency connection needs `location_id` for sub-account routes.
Never reachable through it: sign-in (`/api/auth/*`), people (`/api/users`, `/api/me/*` – passwords, 2FA, passkeys, sessions), API
and agency keys, AI tool keys (also the agency's), AI providers and personal AI subscriptions, OAuth apps and grants (`/api/oauth`, `/api/mcp-oauth`, any `…/oauth/…`), agency sign-in and SSO
settings, invitations and sign-in links, device pairing and push tokens, secret rotation, the cloud team, console and export, and
database backups (`/api/admin/backup(s)`, offsite backups). Paths are checked after resolving `..`, repeated slashes and escapes, as
the router sees them. The HyperLevel Agent treats a `GET` as a read and everything else as a change that needs confirmation.

## AGENTS.md / CLAUDE.md

The KI-Werkzeuge page has a ready-made snippet for your repositories' `AGENTS.md` (Codex) or `CLAUDE.md` (Claude Code). It tells the agent which HyperLevel tools exist (project profile, contacts, deals, tasks, inbox, drafts), which sub-account the connection is scoped to, that `ghl_send_message` really sends (ask first), and to link its Codex task or Claude session to the project with `ghl_update_project` (`codex_sessions` / `claude_sessions`).

## Connected apps and revoking

"Verbundene Apps (OAuth)" lists every app connected via OAuth with its rights, who allowed it and when it was last used. **Trennen** ends the connection at once (all its tokens). Apps can also sign out themselves via the revocation endpoint.

A connection also ends by itself when the login that allowed it is deleted, loses access to the sub-account or loses the *Einstellungen* area (or, for agency connections, is no longer an admin).

## Security model

| Credential | Reaches | Who can create it |
| --- | --- | --- |
| `pghl_…` sub-account key | one sub-account (tools for all sub-accounts are hidden) | logins with the settings area of that sub-account |
| `pghla_…` agency key | all sub-accounts (`x-location-id`), read only or read & write | admins, only on the agency page |
| OAuth connection to a sub-account | exactly like a `pghl_` key (optionally read only) | logins with the settings area of that sub-account, on the consent screen |
| OAuth connection to the agency | exactly like a `pghla_` key | admins, on the consent screen |

- OAuth 2.1: authorization code with **PKCE (S256 only)**, redirect URIs must match the registered ones **exactly** (https, or http only on localhost/127.0.0.1 for local apps, or a private scheme like `cursor://`), `state` is passed back, the `iss` parameter is added.
- Codes live **5 minutes** and are **single-use** – a second use revokes everything issued from that code.
- Access tokens (`pghlo_…`) live **1 hour**; refresh tokens (`pghlr_…`, 30 days) **rotate** on every use, and a reused old refresh token ends the connection. Tokens are stored as SHA-256 hashes only.
- OAuth tokens only work on `/mcp` (the REST API accepts them only from the MCP relay, never directly).
- Registration, authorization, token and revocation endpoints are rate limited per IP; consent per user.
- Audit log entries: `mcp_oauth.client.register`, `mcp_oauth.consent`, `mcp_oauth.deny`, `mcp_oauth.token`, `mcp_oauth.revoke`, `ai_tools.key.create`, `ai_tools.agency_key.create`; every tool call shows up with the path "MCP".
- The consent screen shows where the code will be sent and warns about unknown addresses (known: ChatGPT, Claude, local apps, Cursor, VS Code). Only allow access when you started the connection yourself.
- Keys never create keys, and keys or tokens can't approve OAuth requests – only a person signed in to the browser can.

Reverse proxy: `/mcp`, `/oauth/*` and `/.well-known/oauth-*` must reach HyperLevel (they do when the whole domain is proxied).

Endpoints for developers: [docs/api.md](api.md#oauth-for-mcp-clients).

## Codex tasks per project

Like Claude sessions, a project profile can link Codex tasks: **Projekt → Codex-Aufgaben** takes any `https://chatgpt.com/codex/…` link (task or environment) or a bare task id (`task_e_…`). The **Codex** button next to **Claude** opens it from the project page, the project switcher and the project overview; **Ctrl+K** lists "Codex: <project>". Over MCP: `ghl_update_project` with `codex_sessions: [{label, url}]`.

Documents and the agency inbox accept chatgpt.com links too: Codex tasks are filed as sessions (source "Codex"), ChatGPT canvases as artifacts, shared chats as documents – recognised automatically when `kind`/`source` are left out.

## GitHub issues for Codex (workflow action)

Workflow action **"GitHub-Issue für Codex anlegen"**: creates an issue in a repository with your title and description, the contact's name, e-mail, company and a link back to the CRM, and a last line `@codex <your instruction>`, so Codex cloud picks the issue up as a task.

1. Settings → KI-Werkzeuge → **GitHub für Codex**: a fine-grained GitHub token with "Issues: read & write" for the repositories (stored encrypted, never shown again) and a default repository (`owner/name`). **Zugriff prüfen** checks token and repository without creating anything.
2. The repository must have the **Codex GitHub integration** enabled (connect GitHub in Codex at chatgpt.com/codex and allow the repository) – otherwise the issue is created but nobody picks it up.
3. In a workflow, add the step, set title, description, the instruction for Codex and optional labels (merge fields like `{{contact.first_name}}` work everywhere). The contact's timeline gets an entry with the issue link.

## OpenAI as AI provider

The AI assistant (reply suggestions, summaries, chat bot, workflow "KI-Text", phone agent, video recycling, app dictation) can run on OpenAI instead of Claude – per sub-account with an agency default. See [docs/ai-assistant.md](ai-assistant.md#ai-provider-anthropic-or-openai).
