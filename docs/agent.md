# HyperLevel Agent (KI-Agent)

The HyperLevel Agent is an AI co-worker **inside the web app**. It can do what you can do – search, summarise, create and update records, write messages, build reports – by calling the same tools the [MCP server](api.md#mcp-server) offers, **in-process with your login, your rights and your sub-account**. Before it changes anything it shows you a confirmation card with the exact action.

On top of the built-in agent you can build **your own agents** ("eigene KI-Mitarbeiter", like Custom GPTs) with a role, instructions, tools, knowledge, a safety mode, starter prompts, schedules and an auto-reply for the inbox.

- [Open the agent](#open-the-agent)
- [Models: bring your own key](#models-bring-your-own-key)
  - [Ersatzmodelle](#ersatzmodelle)
- [Safety model](#safety-model)
- [Tools](#tools)
- [Abdeckung](#abdeckung)
- [Custom agents](#custom-agents)
- [Build with AI](#build-with-ai)
- [Automations](#automations)
- [Use your ChatGPT or Claude subscription](#use-your-chatgpt-or-claude-subscription)
- [MCP, mobile app and API](#mcp-mobile-app-and-api)
- [Costs and limits](#costs-and-limits)
- [For developers](#for-developers)

## Open the agent

- **KI-Agent** button in the top bar, or **Ctrl+J** (Mac: **⌘+J**) on every page. The drawer opens on the right; on phones (and in the Android app's WebView) it is full screen. The ⤢ button switches to full-screen on desktop, **Esc** or **✕** closes it.
- **KI-Agenten** in the sidebar: your agents, templates, approvals, ChatGPT/Claude options, the bridge, models and usage.
- **Fokus-Modus mit Companion** ([living-boards.md](living-boards.md#fokus-modus-mit-companion)): the same agent as a voice companion – *"Hey Jarvis"*, the edge button on the right or **Alt+J** on every page. In focus mode a request to do something goes to the agent you picked as companion (built-in = "Jarvis", or one of your agents); its answer, tool cards and confirmation cards render right there (`source: "focus"`, history label *Fokus*, **Im Agent-Panel weiterführen** opens it here). Voice never confirms – the card waits for a click. Proactive check-ins and "Was brennt?" suggest next steps that become the agent's task, never actions of their own.

In the chat:

| | |
| --- | --- |
| Context chip | Shows what you have open ("Kontakt: Max Mustermann") – on every record page: contacts, companies, conversations, tickets, invoices, forms, funnels, workflows, courses, campaigns, contracts, webinars, boards and wiki pages. It is sent with your message so "summarise this contact" or "erledige das hier" works; when only the address is known, the server finds the record itself (with your rights). The companion in focus mode sends the page it was opened from. Click the chip to leave the context out. |
| Agent switcher | The built-in **HyperLevel Agent** or one of your agents (top left). |
| Model chip | Which model answers this chat – the default from [KI-Anbieter](ai-providers.md), any other text connection, or your own subscription: **Mein ChatGPT-Abo** ([sign-in](#d-mit-chatgpt-anmelden-direct-personal)) or **Mein Abo über die Bridge** ([bridge](#c-local-bridge-experimental)). |
| Streaming | Answers appear while they are written (server-sent events). |
| Tool cards | Every step the agent takes: what it searched or changed, expandable arguments and result, links to the records. |
| Confirmation cards | Before changes (see [safety](#safety-model)): exact action, recipient and arguments – **Ausführen** or **Ablehnen**. |
| Stop | Stops the current run (also server-side). |
| History | Your conversations per sub-account (the clock icon); automatic runs (workflow, schedule, auto-reply) show up there too. |
| Files | 📎 attach CSV (the agent can import contacts from it), text/JSON, or images (read by models with vision). Up to 8 MB per file, kept 30 days, visible only to you. |
| Voice | 🎤 dictation via the browser's Web Speech API where available (Chrome, Edge, Android). |
| Markdown | Answers are rendered as sanitised Markdown (React elements only, no HTML); links like `/app/contacts/<id>` open inside the app. |

## Models: bring your own key

The agent uses the **KI-Anbieter (BYOK)** registry – any text model with your own key: OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, Together, Fireworks, DeepSeek, Mistral, xAI, Perplexity, Cerebras, Hugging Face, Azure OpenAI, Ollama, LM Studio, vLLM/LiteLLM or any OpenAI-compatible URL. See [docs/ai-providers.md](ai-providers.md) for every provider, base URL and where to get keys.

Which model the agent uses (first match wins):

1. The model picked in the chat (or set on a custom agent).
2. The routing **"KI-Agent (Chat & Werkzeuge)"** of the sub-account, then the sub-account's own text connections.
3. The agency routing, then agency connections.
4. Keys the KI-Assistent already has (its Anthropic key, the OpenAI provider of the KI-Werkzeuge, `PGHL_ANTHROPIC_API_KEY`, `PGHL_OPENAI_API_KEY`) – so the agent works out of the box when the assistant is set up.

Wire formats: the **Anthropic Messages API** (tool use, streaming, prompt caching on tools/system/newest turn, adaptive thinking blocks passed back in tool loops) and **OpenAI-compatible Chat Completions** (`tools`, `tool_choice: auto`, streamed `tool_calls`, `stream_options.include_usage` where supported). For tool use pick a model that supports tool calling – **Verbindung testen** on the KI-Anbieter page sends one tiny request with a test tool and tells you.

### Ersatzmodelle

A failing model no longer ends the run with an error. On a **retryable provider error** – HTTP 5xx (*"Internal error"*), 429, *overloaded*, kie.ai's *no_available_account* (also when it comes as an HTTP 200 error envelope), a timeout or a dropped connection – the request is **retried once**, then the agent tries the **next model of the same connection**, then the sub-account's **other text connections** (own first, then agency, then the KI-Assistent's keys):

1. The routing's **Ersatzmodelle** of that usage (*Einstellungen → KI-Anbieter → Wofür welches Modell?*, field *Ersatzmodelle* under the model – folded under *Ersatzmodelle* in Einfach-Modus; up to five model ids, comma separated). Empty = the provider's default order: for **kie.ai** `claude-sonnet-5-5 → claude-sonnet-5 → claude-haiku-5-5`.
2. Every other enabled text connection with its default model (at most six fallbacks in all).

The rest of the run stays with the model that answered. Which one answered is logged: every failed attempt is an AI call with status *error* and its model, the answer one with status *ok*; the chat stream gets a `model` event (`{provider, model, label, fallback: true, tried}`) and the server log a line *Ersatzmodell hat geantwortet*. Errors a new model cannot fix end the run as before: a bad key, billing, a refusal, a too large request, or you stopping it. Text already streamed is never repeated by a second model. The KI-Assistent's quick texts (`aiRun`) use the same chain when they are routed to a connection. In focus mode, when no model answers at all, Jarvis answers by rules from the growth review ([living-boards.md](living-boards.md#business-developer)).

## Safety model

**Identity.** Every tool call runs in-process as you: the same route, the same guards (member areas, SaaS plan), the same validation, events and audit log. In the audit log the actor is **"KI-Agent (im Auftrag von <name>)"** and the path is `agent`. A client login (member) can never reach another sub-account: `location_id` is not even in its tool schemas, and anything the model smuggles in is replaced by the current sub-account. Admins act on the current sub-account unless they name another one.

**Never.** Whatever you could do, the agent never touches identities and keys: users, your account/password/2FA, sessions, API and agency keys, OAuth apps, mobile pairing, push devices, backups, AI keys and settings (also the agency's), KI-Anbieter, personal ChatGPT/Claude subscriptions, its own agents and settings.

**Modes** (per agent; the built-in agent's mode is set per sub-account under KI-Agenten → Nutzung):

| Mode | Reads | Changes (create, update) | Sends, deletes, pays, publishes, social posts |
| --- | --- | --- | --- |
| **Nur lesen** | ✅ | ❌ blocked (the tools aren't even offered) | ❌ blocked |
| **Vor Änderungen fragen** (default) | ✅ | confirmation card | confirmation card |
| **Termin buchen** | ✅ | confirmation card – except **looking up free times and booking a free slot** (`ghl_booking_slots`, `ghl_book_appointment`), which run on their own, also after reading a customer's message | confirmation card |
| **Autonom** | ✅ | runs | confirmation card – an **agency admin** can switch this off per agent |

**Tool classes.** Each tool is `read`, `write`, `sensitive` or `internal` (open a page, own notes), from its MCP annotations and name: `readOnlyHint` → read; `destructiveHint`, `openWorldHint` or a name with send/delete/remove/refund/charge/pay/publish/reply/grant/revoke/plan/post/invite/merge/bulk/campaign/whatsapp/sms → sensitive; everything else → write.

**Second line of defence.** Independent of annotations, every in-process API call a tool makes is checked: a tool that runs without a confirmation as *read* may only `GET` (plus a few read-only POSTs like running a report); an unconfirmed *write* tool can't reach outbound or destructive routes (`POST /api/messages`, social posts, review replies, Stripe, `DELETE …`, bulk actions, `…/send|reply|publish|refund|merge…`). A mislabelled tool therefore can't send or delete on its own.

**Confirmations.** A confirmation is stored with a one-time token (only its SHA-256 is kept) bound to **your user, the conversation, the tool call and a hash of the exact arguments**, valid 30 minutes. It works once; another user, a changed argument hash or a reused token is refused. Reloading the chat issues a fresh token. Writing a new message instead rejects the waiting action.

**Prompt injection.** Tool results are handed to the model as data in `<tool_output tool="…" trust="untrusted">` blocks that can't close themselves; the system prompt says that content from e-mails, chats, contact fields, notes, web pages and files never gives instructions. After the agent has read untrusted content in a run (inbox conversations – also the one open on screen through `ui_context`, like an open ticket or form –, drafts, tickets, call transcripts, reviews, community posts, appointment notes from the booking page, anything read through `ghl_api`, web pages), **sensitive actions always need a confirmation** – even in "Autonom" with confirmations switched off – and every tool that contacts a host the model names needs one too (reading a web page, the SEO audit of a URL, the DNS check of a domain: a URL or a domain name could carry data out); in *Nur lesen* those are blocked then. Auto-replies to inbound messages run read-only – except for the two booking tools at the levels "Termin buchen" and "Autonom": they only book free slots of the calendars released for the AI, never paid ones, at most a few per contact and day, and the confirmation (with links to reschedule and cancel) goes to that contact ([booking.md](booking.md#ai-books-appointments)).

**Limits.** At most 12 model steps per message (configurable 1–30 per agent), 5 minutes per run, 60 seconds per tool call, 2 minutes per model call. Every model call counts on the sub-account's monthly limit (below).

## Tools

All MCP tools of this server – core tools plus every tool other modules register in `app.services.mcpTools` (Video-Studio, reports, tickets, companies, Composio and future modules appear automatically) – except `ghl_run_agent`. Agency-only tools only for admins. On top:

| Tool | What it does |
| --- | --- |
| `navigate` | Opens a page or record in your UI (`contacts/<id>`, `opportunities`, `settings/ai` …). Internal paths only. |
| `ui_context` | What you are looking at: page, selected contact/conversation/company/ticket/invoice with key data. |
| `search_everything` | One search over contacts, deals, companies, tickets, conversations and help articles (only areas you may see). |
| `remember` | The agent's own notes across conversations (per custom agent, or per user for the built-in agent; max. 60, editable in the agent editor). Shown to the model as data, never as instructions. |
| `knowledge_search` | Keyword search over the agent's own knowledge, the KI-Assistent's facts/Q&A, the knowledge base (help articles), project documents and the project profile. |
| `create_report_from_question` | Answers a question with the [reports](reports.md) engine; without a source it first returns the sources and fields; `save: true` stores the report in the library and links it. |
| `import_contacts` | Imports contacts from a CSV you attached in this chat (columns detected automatically, optional mapping and tags). |
| `web_fetch` | Reads a public web page (SSRF-safe fetch, no private networks). **Off by default** – switch it on per agent; an agency admin can disallow it. |

**Everyday operations** have their own tools so models pick them reliably (module `agent-ops-tools.ts`): `ghl_update_task`, `ghl_list_appointments`, `ghl_create_appointment`, `ghl_update_appointment` (move, confirmed/showed/no-show – other statuses are refused), `ghl_cancel_appointment`, `ghl_update_contact`, `ghl_tag_contact`, `ghl_merge_contacts`, `ghl_draft_email` (a reply draft – never sends), `ghl_draft_message` (an SMS or WhatsApp reply draft that opens in the inbox composer – never sends; module `msg-drafts.ts`, [team-inbox.md](team-inbox.md#sms-and-whatsapp-drafts)), `ghl_create_invoice` (invoice or quote as a draft), `ghl_list_campaigns`, `ghl_create_campaign` (draft), `ghl_list_workflows`, `ghl_workflow_enroll`, `ghl_workflow_set_status` (pause/activate), `ghl_list_forms`, `ghl_form_submissions`, `ghl_survey_results`, `ghl_list_reviews`, `ghl_settings_overview`. Cancelling, marking a no-show (the calendar's no-show message goes out at once), merging, enrolling, activating a workflow and booking with a confirmation mail are **sensitive** (always a card); drafts are plain changes. The create/update tools pass on only the fields their schema names – a draft invoice can't carry a recurring schedule (which would finalise and send it by itself) or a payment link. Everything else: `ghl_api_routes` finds the route ("formular einsendungen", "rechnung storno"), `ghl_api` calls it – a `GET` reads, anything else asks first ([ghl_api](ai-tools.md#ghl_api-every-app-function)). Agents in *Nur lesen* get both too: their `GET`s run, everything else is blocked.

**Noise-free results.** What a tool returns reaches the model and the card trimmed: empty fields and the current sub-account's own id left out, one-time links and secrets dropped, very long texts and lists over 60 entries cut with a note.

**External tools** (`app.services.agentToolSources`): the enabled tools of [external MCP servers](mcp-client.md) (`ext_<server>_<tool>`, when the server's switch *Im KI-Agenten* is on) and Nango's `nango_request` ([nango.md](nango.md), within the allow-list) join the catalogue per sub-account and user (members need the automations area). They run in third-party systems, so their output is always untrusted (it taints the run) and they count as **sensitive** – confirmation as for outbound actions – unless the source marks them `readOnlyHint` (then **read**). Custom agents with an explicit tool list only get the external tools listed there. Contract: [mcp-client.md](mcp-client.md#agent-tool-sources).

## Abdeckung

Which areas agents reach is computed from the router, not maintained by hand (`server/services/agent-coverage.ts`): every module with routes behind a login is checked – **eigenes Tool** (a tool the module registers or whose calls hit its routes), **über `ghl_api`** (its routes are callable; changes always ask first in the agent) or **gesperrt** (on the exemption list `AGENT_EXEMPT`, each with its reason). `tests/agent-coverage.test.ts` fails when a new module's write routes reach no agent and it is not exempted, when an exemption is stale, when a read tool would write, a write tool would reach an outbound route without the class *sensitive*, or a tool calls a route without login.

| Modules with write routes (255 of 273) | before | now |
| --- | --- | --- |
| changed by an own tool | 96 | 100 (+ calendars, workflows, payments/invoice drafts, contact merge) |
| read by an own tool (all 273) | 125 | 131 (+ forms, form library, surveys, reviews, appointments, workflows) |
| only through `ghl_api` | 137 | 130 |
| unreachable – all on purpose | 22 | 25 (+ the agency's AI keys and provider, personal AI subscriptions) |

Everyday areas at a glance:

| Area | Read | Change |
| --- | --- | --- |
| Contacts | `ghl_search_contacts`, `ghl_get_contact`, `ghl_contact_duplicates` | `ghl_upsert_contact`, `ghl_update_contact`, `ghl_tag_contact`, `ghl_add_note`, `ghl_merge_contacts`* |
| Tasks | `ghl_list_tasks`, `ghl_list_all_tasks` | `ghl_create_task`, `ghl_update_task`, `ghl_complete_task` |
| Appointments | `ghl_list_appointments`, `ghl_booking_slots` | `ghl_book_appointment`, `ghl_create_appointment`*, `ghl_update_appointment`, `ghl_cancel_appointment`* |
| Deals | `ghl_list_opportunities`, `ghl_list_pipelines`, `ghl_deal_lines` | `ghl_create_opportunity`, `ghl_update_opportunity` (stage, won/lost) |
| Inbox | `ghl_list_conversations`, `ghl_get_conversation`, `ghl_list_drafts` | `ghl_draft_email`, `ghl_draft_message`, `ghl_ai_suggest_reply`, `ghl_send_message`* |
| Invoices & quotes | `ghl_list_invoices`, `ghl_quote_list` | `ghl_create_invoice`, `ghl_quote_create`, `ghl_invoice_finalise`, `ghl_quote_send`* |
| Campaigns | `ghl_list_campaigns` | `ghl_create_campaign` (draft) |
| Automations | `ghl_list_workflows`, `ghl_workflow_catalog` | `ghl_workflow_enroll`*, `ghl_workflow_set_status` (activate*) |
| Forms & surveys | `ghl_list_forms` (with a `mapping` count per form), `ghl_form_mapping` (where a form's fields write besides the contact – read only), `ghl_form_submissions`, `ghl_survey_results` | through `ghl_api` |
| Reviews & social | `ghl_list_reviews`, `ghl_google_reviews`, `ghl_list_social_posts` | `ghl_suggest_review_reply` (draft), `ghl_create_social_post` (draft) |
| Reports & settings | `ghl_run_report`, `create_report_from_question`, `ghl_settings_overview` | through `ghl_api` |

\* sensitive: always a confirmation card.

**Gesperrt** (never for agents): sign-in, 2FA, passkeys, sessions, SSO and login rules, the own language and calendar connections, keys (API, AI tools, MCP OAuth, OAuth connections), AI providers, connections and personal AI subscriptions, the agents' own configuration and bridge pairing, device pairing and push tokens, database backups, invitations – and the mobile app's mirror routes (`/api/mobile/*`), whose actions the regular tools cover. The test also found two gaps that are closed now: the agency's AI keys/provider and personal ChatGPT/Claude subscriptions were reachable through `ghl_api`, and the read-only calculation and dry-run tools (`ghl_calc_run`, `ghl_calc_breakeven`, `ghl_calc_scenario_run`, `ghl_workflow_test_run`, `ghl_workflow_generate` preview) were refused inside the agent.

New module? Register tools in `app.services.mcpTools` for its everyday actions (read-only tools `readOnlyHint`, outbound ones `destructiveHint`/`openWorldHint`), or leave it to `ghl_api` – and only add it to `AGENT_EXEMPT` when agents must not touch it.

## Custom agents

**KI-Agenten → Neuer Agent** or **Vorlagen**. Fields:

- **Grundlagen:** name, emoji, colour, role (shown on the card), instructions, starter prompts, visibility – *Nur ich*, *Agentur-Team* (all admins; admins only) or *Alle im Sub-Account* (also client logins). Only the owner edits; admins may edit shared agents.
- **Modell & Werkzeuge:** a connection (default, any text connection, or the bridge) and an optional model id (free text); all tools (including future ones) or a grouped checklist.
- **Sicherheit:** mode, "always confirm sending/deleting/payments" (only admins can switch it off), web pages yes/no, max. steps.
- **Wissen:** sources (own knowledge, KI-Assistent, knowledge base, documents, project profile), own knowledge text, memory on/off and the stored notes.
- **Automatisch:** schedules and the inbox auto-reply (below).

**Templates:** Vertriebs-Assistent, Support-Agent, Social-Media-Manager, Projekt-Manager, Rechnungs-Assistent, Onboarding-Coach, Daten-Aufräumer, Lead-Recherche. **Clone**, **export** (JSON, format `gohigh-agent`, without owner, visibility, connection or auto-reply) and **import** are on each card.

## Build with AI

**KI-Agenten → Mit KI erstellen** (like HighLevel's Agent Studio "Build with AI"): describe the agent in plain words – "every Monday at 8 a report on open deals and overdue tasks by e-mail" – and the AI proposes the whole config: **name, emoji, role, instructions, model** (empty = the connection's default), **the tool checklist** chosen from the agent's **real tool catalogue** (the same list the editor shows, with what each tool may do), **knowledge sources**, **safety mode**, **max. steps**, starter prompts and an optional **schedule**. The answer is checked against the custom-agent schema and the tool registry (unknown tools, modes, knowledge sources or a broken schedule go back to the AI – up to three attempts, the same ask-check-retry loop as the [Funnel & Website AI](site-ai.md#how-the-answer-is-checked)). The review shows instructions, tools (*liest*, *ändert*, *versendet/löscht*), mode, knowledge, schedule, notes and the cost; **Als Entwurf speichern** creates the agent as a **draft: private, its schedule saved but switched off, no inbox auto-reply** – the editor opens so you can test it, then switch the schedule on or share it.

Model routing, estimate and monthly limit are those of the KI-Assistent (purpose *KI-Agent mit KI erstellen*). API: `GET /api/agent-ai/status`, `POST /api/agent-ai/generate` `{prompt}` → `{run_id, config, tools, summary, notes, warnings, cost_usd}`, `POST /api/agent-ai/runs/:id/apply` → the new agent (`draft: true`); a run belongs to the person who started it, kept 30 days. MCP **`ghl_agent_generate`** `{location_id, prompt, apply?}`: needs a signed-in person (agents belong to a person); the HyperLevel Agent itself may draft but never saves an agent – agent configurations stay off-limits to it.

## Automations

Automatic runs act as the **agent's owner, limited to the agent's sub-account** (never agency-wide), in the agent's mode. Nothing that needs a confirmation runs: it becomes an **approval** under **KI-Agenten → Freigaben** (with tool, arguments and recipient; owner or admin decide; 7 days valid). The run's conversation appears in the owner's history.

- **Workflow action "KI-Agent ausführen"** (`agent_run`): agent, task with placeholders (`{{contact.first_name}}` …), the contact and the trigger's event data as context (the event data marked untrusted), answer to the run log, a note on the contact or a custom field (`custom.<key>`). Agents a workflow may use: shared ones and your own.
- **Schedules:** daily, on weekdays, weekly (weekday) or monthly (day 1–28) at a time in the sub-account's time zone; the result as a push notification, an e-mail to the owner or a task (reaches Todoist when the [Todoist sync](todoist.md) is on). Once per period; "run now" in the editor via `POST /api/agents/:id/schedules/:sid/run`.
- **Auto-reply in the inbox:** per agent and channel (e-mail, SMS, website chat, WhatsApp, Messenger, Instagram; one agent per channel and sub-account). The agent reads the conversation (as untrusted data), may look things up (read-only tools, no web), and writes a **draft** (source "KI-Agent") – or **sends** it when the agent is in "Autonom" and the reply mode is "Direkt senden". At the levels "Termin buchen" and "Autonom" it may also **book a free appointment** for the customer (the booking tools are offered even when the agent's tool list leaves them out); the confirmation goes out in the customer's channel at once, the reply follows the reply mode. It integrates with the [KI-Assistent](ai-assistant.md) instead of duplicating it: the assistant's chat bot keeps the website chat while it is on, its e-mail drafts keep e-mail while they are on; paused or handed-off chats, chats the team answered in the last 2 hours and (optionally) business hours are left to the team; at most 30 auto-replies per hour and sub-account.

## Use your ChatGPT or Claude subscription

> **Legal note.** ChatGPT Plus/Pro and Claude Pro/Max are personal subscriptions. HyperLevel uses them only the official ways: **HyperLevel as a tool inside ChatGPT/Claude** (connector or Custom GPT), the **official CLIs on your own computer** (bridge), and – for ChatGPT on self-hosted installations only – OpenAI's own **"Sign in with ChatGPT" for open-source apps** (option D). For Claude, HyperLevel never receives, extracts or stores Claude.ai logins or OAuth tokens: Anthropic does not allow third-party apps to offer Claude sign-in. For automations, teams and clients use API keys (KI-Anbieter). Sources and details: [docs/ai-providers.md](ai-providers.md#subscription-sign-in-mit-chatgpt-anmelden-mit-claude-verbinden).

### A) In ChatGPT or Claude (recommended)

You chat in ChatGPT or Claude.ai with your subscription; HyperLevel is a **connector** there (MCP with OAuth). Setup and keys are on the page **Settings → KI-Werkzeuge** ([docs/ai-tools.md](ai-tools.md)); **KI-Agenten → In ChatGPT & Claude** shows the connector URL (`https://<your-domain>/mcp`) and the short steps. Your custom agents are available there via `ghl_list_agents` / `ghl_run_agent`.

### B) Custom GPT with HyperLevel actions

**KI-Agenten → In ChatGPT & Claude → Schlüssel & Schema anlegen** creates a scoped key (`gha_…`, per user and sub-account, shown once) for a subset of tools (default 20, at most 30 – ChatGPT's limit) and an **OpenAPI 3.1** schema:

```
GET  /api/agent/gpt-actions/openapi.json?k=<key-id>     (public, no secrets)
POST /api/agent/gpt-actions/tools/<tool>                 Authorization: Bearer gha_…
```

In ChatGPT: *Explore GPTs → Create → Configure → Create new action → Import from URL*, authentication **API Key → Bearer**, paste the key. Each operation is a POST with the tool's JSON schema; operations that change something are marked `x-openai-isConsequential: true`, so ChatGPT asks before running them. Keys are **read-only** unless "Darf ändern" is ticked; sending/deleting/payments additionally need an agency admin. Calls run as the key's owner in that sub-account and show up in the audit log. (For OAuth instead of a key, use the connector in A.)

### D) Mit ChatGPT anmelden (direct, personal)

**Einstellungen → KI-Anbieter → Mit deinem Abo → Mit ChatGPT anmelden**: you sign in at OpenAI (their official flow for open-source apps) and paste the address the browser lands on; HyperLevel keeps the tokens sealed for you alone and refreshes them. Then pick **"Mein ChatGPT-Abo"** in the chat's model picker. It works only in your own browser chat (never for custom agents, automatic runs, workflows or other people), shows "Dein ChatGPT-Abo · Nutzung ↗" while it is in use, counts on your ChatGPT plan's limits, and an agency admin can switch it off. Not available on an installation run as a hosted service until OpenAI has approved it. Details: [docs/ai-providers.md](ai-providers.md#subscription-sign-in-mit-chatgpt-anmelden-mit-claude-verbinden).

### C) Local bridge (experimental)

> Easiest: **Einstellungen → KI-Anbieter → Mit deinem Abo → Mit Claude verbinden** (or *Oder: über die Codex CLI*) – one copyable command, a pairing code with QR code, live status (connected, last seen), your model, reconnects by itself. Details in [docs/ai-providers.md](ai-providers.md#the-local-bridge-claude-code-and-codex-cli). The steps below are the manual version.

**Läuft auf deinem Rechner mit deinem eigenen Abo – nur für dich selbst.** An agency admin first allows it (*KI-Agenten → In ChatGPT & Claude → Lokale Bridge erlauben*).

1. Install Node.js 18+ and **Codex CLI** (`npm i -g @openai/codex`, `codex login` → *Sign in with ChatGPT*) or **Claude Code** (`npm i -g @anthropic-ai/claude-code`, run `claude` and log in with your Claude account).
2. Download `gohigh-bridge.mjs` (*KI-Agenten → Mit deinem Abo*, or `GET /api/agent/bridge/script`; the file is `bridge/gohigh-bridge.mjs` in this repo – no dependencies, Node built-ins only).
3. **Einmal-Code erzeugen**, then on your computer: `node gohigh-bridge.mjs pair https://<your-domain> ABCD-EFGH` (the code is valid 10 minutes, single use). The device token (`ghb_…`) is stored in `~/.gohigh-bridge.json` (mode 600); HyperLevel keeps only its hash.
4. Run `node gohigh-bridge.mjs` and leave it running. In the chat pick the model **"Mein Abo über die Bridge"**.

How it works: the bridge keeps an **outbound** long-poll (`GET /api/agent/bridge/poll`, no open ports). For each chat message it receives the prompt (agent role, instructions, recent turns) and a **per-job MCP token** (`ghbj_…`, valid only while the job runs), starts the CLI in an empty temporary folder and streams its output back (`POST /api/agent/bridge/jobs/:id/events|done`). The CLI only talks to HyperLevel's tools at `/api/agent/bridge/mcp` – the bridge always uses the HyperLevel address it was paired with, never a host the server names – and those tool calls run in-process with your rights and your agent's safety mode; confirmations appear in the web chat while the CLI waits (up to 5 minutes).

| CLI | Command the bridge runs (prompt on stdin) |
| --- | --- |
| Claude Code | `claude -p --output-format stream-json --verbose --mcp-config <tmp>/mcp.json --strict-mcp-config --allowedTools mcp__gohigh --disallowedTools Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Task` (the MCP config with the job token is a 0600 file in the temp folder) |
| Codex CLI | `codex exec --json --skip-git-repo-check --sandbox read-only -C <tmp> -c mcp_servers.gohigh.url="…/api/agent/bridge/mcp" -c mcp_servers.gohigh.bearer_token_env_var="GOHIGH_MCP_TOKEN" -` (token in the environment, not on the command line) |

Extra arguments: `GOHIGH_CLAUDE_ARGS`, `GOHIGH_CODEX_ARGS`; other binaries: `GOHIGH_CLAUDE_BIN`, `GOHIGH_CODEX_BIN`. `node gohigh-bridge.mjs status` shows the pairing and installed CLIs, `unpair` removes it (devices can also be removed in HyperLevel). The bridge is for interactive chats only – never for automations or other people.

## MCP, mobile app and API

- **MCP:** `ghl_list_agents` and `ghl_run_agent` (`location_id`, `agent_id`, `prompt`) run a custom agent within the caller's scope: sub-account keys see shared agents only; the agent runs as its owner (limited to that sub-account); confirmations become approvals.
- **Mobile app** (bearer `ghm_…`, see [docs/api.md](api.md#mobile-app)): `GET /api/mobile/agent?location=`, `POST /api/mobile/agent` `{location_id, message, agent_id?, conversation_id?}` → `{conversation_id, status, text, tools, confirmation, approvals}`, `POST /api/mobile/agent/confirm` `{location_id, pending_id, token, approve}`, `GET /api/mobile/agent/conversations/:id?location=`.
- **REST** (session; `x-location-id`): `POST /api/agent/chat` (SSE), `POST /api/agent/confirm` (SSE), `POST /api/agent/run` (JSON; with an API key the agent runs as its owner), conversations, files, approvals, agents – the full list is in [docs/api.md](api.md#ki-agent).

Stream events (`data: {…}`): `start`, `text` (`delta`), `tool` (`id, name, title, klass, args, status`), `tool_result` (`id, status: ok|error|blocked|rejected|deferred, links, preview|error`), `confirm` (`pending_id, token, tool, title, klass, args, args_hash, summary, target`), `navigate` (`to`), `usage`, `bridge`, `error`, `done` (`status: done|awaiting|stopped|error|limit`).

## Costs and limits

Model calls are logged in the KI-Assistent's usage log (purpose *KI-Agent* / *KI-Agent (automatisch)*) and **count on the sub-account's monthly limit** (Settings → KI-Assistent; cost and optional token limit) and on the SaaS plan's AI quota. **KI-Agenten → Nutzung** shows the month per agent and person and the last runs; **KI-Anbieter** shows calls and costs per connection. Costs are estimates from the connection's price per million tokens (built in for Anthropic models, editable per connection; local models 0). Settings per sub-account: agent on/off, mode of the built-in agent, web pages for the built-in agent.

## For developers

- Modules: `server/modules/agent.ts` (chat, confirmations, history, files, memory, approvals, usage, `app.services.agent`), `agent-custom.ts` (agents, templates, workflow action, schedules, auto-reply, `app.services.agentDefs`), `agent-connect.ts` (GPT actions, MCP tools, mobile API), `agent-bridge.ts` (bridge), `ai-connections.ts` (BYOK registry).
- Services: `services/agent-llm.ts` (neutral messages, SSE parser, Anthropic + OpenAI-compatible adapters, `chatWithTools`), `agent-runtime.ts` (tool loop, prompt, resumable state), `agent-safety.ts` (classes, decisions, route checks, wrapping, argument hashes), `agent-tools.ts` (MCP bridge in-process, agent tools), `agent-templates.ts`, `ai-presets.ts`, `ai-compat.ts`.
- External tools: `externalTools`/`withExternal` in `services/agent-tools.ts` adapt `app.services.agentToolSources` (`services/agent-tool-sources.ts`) for each run, confirmation and approved deferred action.
- Test hooks: `app.services.agentFetch` (model calls of the agent), `app.services.aiConnectionsFetch` (model lists, connection tests, quick texts through the registry). Tests: `tests/agent*.test.ts`, `tests/ai-connections.test.ts` (fake Anthropic/OpenAI streams, a fake Claude Code CLI for the bridge).
