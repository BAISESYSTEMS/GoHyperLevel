# AI Studio

A chat-first builder for small static apps and websites, like HighLevel's AI Studio or Lovable/Bolt – but **BYOK**: the agent runs on
the sub-account's own text connection (Anthropic Claude, OpenAI, OpenRouter or any other provider of the [AI providers](ai-providers.md)).
In the app it lives at `/app/ai-studio`: menu entry **AI Studio** with a *Beta* pill under *Seiten* (permission area *Funnels & Websites*); in
the Einfach-Modus it sits under "Mehr" until someone uses it a few times, then the adaptive menu promotes it. The Academy has a short tour
(*AI Studio: Apps im Chat bauen*).

## What it does

- **Projects** per sub-account, from a template: *React (Vite)* or plain *HTML*. The files live on disk under
  `<data>/ai-studio/<sub-account>/<project>/` with a quota of 20 MB per project (512 KB per file, 400 files, 50 projects per sub-account).
  Paths are relative and checked: no `..`, no hidden files such as `.env`, `dist/` and `node_modules/` are reserved.
- **Agent turn**: you describe what to build; the model works through seven tools – `list_files`, `read_file`, `write_file`,
  `delete_file`, `search_files`, `run_build`, `read_logs` – for up to 20 steps. The chat shows "Thought for X s", the collapsible
  tool cards ("N tools used") and the files each turn changed.
- **Versions**: every turn that changed files makes a snapshot (the last 40 are kept); restoring one makes a new snapshot, so it can
  be undone again.
- **Getting started**: without a text connection the studio shows "Verbinde deinen Claude-, OpenAI- oder OpenRouter-Key" with a link to
  *Einstellungen → KI-Anbieter*; three example prompts (landing page, booking widget, small calculator app) create a project and fill the chat.
- **Build sandbox**: HTML projects are copied; React projects are bundled by esbuild in a child process – Node permission model (read access only to the installed packages, no file writes), empty environment,
  256 MB memory, 60 s wall clock, and a new network namespace (`unshare -rn`) where the host allows it. The project's files are sent
  over IPC; esbuild never reads the workspace, and only the built-in packages `react` and `react-dom` can be imported.
  **Production:** `esbuild-wasm`, `react` and `react-dom` are runtime `dependencies`, so the Docker image keeps them after
  `npm prune --omit=dev` (no npm install at runtime). esbuild-wasm is pure JavaScript and WebAssembly – the same file on amd64 and
  arm64 – and runs in-process in the sandboxed child through its browser API (no service process, no file access: the plugin hands it
  the workspace and the package files). The native esbuild (a dev dependency through Vite) is faster and used when it is installed.
- **Preview** in an iframe with `sandbox="allow-scripts allow-forms"` under a signed, expiring path (`/studio-preview/<token>/`),
  served with a CSP that sandboxes the page itself (opaque origin, no cookies of the app, `default-src 'none'`).
- **Costs**: tokens and cost per turn and per project; every model call is checked against the KI-Assistent's monthly limit
  (and the SaaS plan) before it is made and lands in the AI usage log (purpose `ai_studio`) and in the connection's usage.
- **Export** as a ZIP of the source (a runnable Vite project for the React template).

## Publish

*Veröffentlichen* in a project builds it and copies the build to `<workspace>/site/`; it is then public at `/apps/<adresse>/`
(the address is taken from the name unless you choose one: 3–48 characters `a–z 0–9 -`, unique on the instance).

- **Static only**, served with `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups …; default-src 'none';
  script-src 'self'; style-src 'self' 'unsafe-inline'; … form-action 'none'; frame-ancestors *` – the page runs in an opaque origin, so
  it never sees the app's cookies or its API, and nothing it does is same-origin with the CRM. No response sets a cookie. Framing is
  allowed because widgets are embedded on other sites.
- **A host of its own**: `PGHL_APPS_ORIGIN=https://apps.example.com` makes the public URLs use that host; on it only `/apps/…` answers.
- **Custom domain** (self-hosted installs): an optional domain per app – the host is rewritten to the app, listed for the Caddy
  on-demand TLS "ask" endpoint (`/api/tls/ask`, [self-hosting](self-hosting.md#own-domains)) and reserved, so no funnel, help center or
  login can claim it. In the cloud the domain field is refused (no DNS check for app domains yet) – use the `/apps/` address there.
- Paths are checked segment by segment (no `..`, no hidden files, nothing outside `site/`); a path without an extension answers with
  `index.html` (single-page app routes). Editing the project does not change the public version until you publish again.
- **Unpublish** removes the files – the address answers 404 and is free again. Deleting the project takes the site down too.
- Publish, republish and unpublish land in the audit log (`ai_studio.publish`, `ai_studio.republish`, `ai_studio.unpublish`).

## API

Session or sub-account key, permission area *Funnels & Websites*:

- `GET /api/ai-studio/setup` – `{ai_ready, settings_path}`: whether a text connection can run a turn
- `GET /api/ai-studio/projects`, `POST /api/ai-studio/projects` `{name, stack: react|html, connection_id?}`
- `GET/PATCH/DELETE /api/ai-studio/projects/:id` – the project with files, turns, versions, preview path, connections and budget; `PATCH` takes `name`, `connection_id`
- `GET /api/ai-studio/projects/:id/file?path=`, `PUT /api/ai-studio/projects/:id/file` `{path, content}`
- `POST /api/ai-studio/projects/:id/turns` `{prompt}` – one agent turn (`402` when the monthly limit is reached, `409` without a text connection or while a turn runs)
- `POST /api/ai-studio/projects/:id/build`, `POST /api/ai-studio/projects/:id/versions/:n/restore`, `GET /api/ai-studio/projects/:id/export`
- `GET /api/ai-studio/projects/:id/publish` (status and public URL), `POST /api/ai-studio/projects/:id/publish` `{slug?, domain?}` (build and
  publish or republish; `409` when the address or domain is taken, `400` when the build fails), `DELETE /api/ai-studio/projects/:id/publish`
- Public: `GET /apps/<slug>/…` – the published files

## Not built yet

DNS verification of custom app domains (needed before the cloud allows them), a subdomain per app, the scoped read-only API token and
key-value store for apps, "point & edit" in the preview, streaming of the turn, Tailwind classes without npm, optional npm packages and a
push to GitHub are planned.

## For developers

`modules/ai-studio.ts` (tables `studio_projects`, `studio_turns`, `studio_versions`, routes, preview), `modules/ai-studio-publish.ts`
(table `studio_sites`, publish routes, `/apps/` serving, host rewrite, domain hooks) and `services/ai-studio.ts` (workspace, templates,
build runner, agent loop, `stubChat`; `buildProject(ws, stack, timeout, 'wasm')` forces the production engine). The web side:
`pages/AiStudio.tsx` and `pages/AiStudioPublish.tsx` (key empty state, examples, publish dialog). Test hooks: `app.services.aiStudioChat` replaces the model call – tests
and screenshots use `stubChat`, a deterministic model that lists, writes, builds and answers without any network – and
`app.services.aiStudioFetch` the HTTP of a real call. Deleting a sub-account removes its `ai-studio/` folder. Tests: `tests/ai-studio.test.ts`.
