**English** · [Deutsch](ai-assistant.de.md)

# AI assistant (Conversation AI)

Every sub-account can get its own AI assistant based on **Claude** (Anthropic) or **OpenAI** (GPT) ([AI provider](#ai-provider-anthropic-or-openai)). It writes reply suggestions and summaries in the inbox, answers the website chat itself if you want, creates reply drafts for incoming e-mails, and is available in workflows and through MCP. The costs run through the customer's Anthropic account (own API key) and are capped per month.

## Setup

1. In the [Anthropic Console](https://console.anthropic.com/settings/keys), create a key under **API Keys** (it starts with `sk-ant-`). Add credit or a payment method in the Anthropic account.
2. **Settings → AI assistant → Setup:** paste the key, **Test connection** (checks the key through the Models API, costs no tokens), tick **Turn on AI assistant**, save.
3. Choose a model: **Claude Sonnet 5.5** (default, fast and cheap), **Claude Opus 5.5** (strongest, more expensive) or **Claude Haiku 4.5** (cheapest).
4. Fill in **Tone & persona** and **Facts about the company**.
5. **Knowledge:** maintain questions & answers and free text. Optionally the **project profile** (short description, description, goals, website – no notes, servers or repos) and the **FAQ blocks** from Funnels & Websites of this sub-account are sent along.
6. **Usage & limit:** monthly limit in US dollars (default $20) and optionally a token limit.

The key is stored encrypted (AES-256-GCM with the server secret) and never sent back to the browser; only the last four characters are shown. Alternatively the agency can set one key for all sub-accounts in the environment: `PGHL_ANTHROPIC_API_KEY` (applies when a sub-account has none of its own; the monthly limit still applies per sub-account).

<a id="ai-provider-anthropic-or-openai"></a>

## AI provider: Anthropic or OpenAI

The assistant runs on **Claude** (Anthropic, default) or **OpenAI** (GPT, through the Responses API) – per sub-account, with an agency default.

- **Settings → AI assistant → Setup → AI provider:** “Like the agency” (take over the agency default), “Anthropic (Claude)” or “OpenAI (GPT)”. For OpenAI you enter an OpenAI API key (from [platform.openai.com → API keys](https://platform.openai.com/api-keys), starts with `sk-`), choose a model and click **Test OpenAI** (checks the key through the Models API, costs no tokens). The fields for the Anthropic key and model step back while OpenAI is selected.
- **Models:** GPT-5 mini (default, fast and cheap), GPT-5.1 (strongest), GPT-5 nano (cheapest), GPT-4.1 mini (no thinking, very fast – good for chat and phone) – or any other model ID as free text (also fine-tuned ones such as `ft:gpt-4.1-mini:org::id`). Reasoning models run at the **reasoning effort** of their capability (default `xhigh`, lowered to what the model accepts; *Settings → AI provider → Reasoning effort*, see [docs/werkstatt.md](werkstatt.md#denkstufe-reasoning-effort)) – set short texts and the phone agent lower to save cost and time.
- **Agency default (Agency → AI tools → AI provider):** provider, model and optionally an OpenAI key of the agency, which every sub-account without its own choice or key uses. Order of keys for OpenAI: the sub-account's key → the agency's key → `PGHL_OPENAI_API_KEY` in the server environment.
- **Everything uses the selected provider:** reply suggestions, summaries, the chat bot, e-mail drafts, the workflow action “Generate AI text”, the phone agent, video recycling and dictation in the app (`app.services.aiRun` doesn't know a specific provider). JSON answers (summaries, chat bot, phone agent, recycling, dictation) use **Structured Outputs** with OpenAI (`text.format: json_schema`, strict when the schema allows it) – so parsing works the same for both.
- **Limit and log stay per sub-account:** the monthly limit, the SaaS plan's limit and the log under **Usage & limit** also count OpenAI calls, priced at OpenAI's list prices (cached input is cheaper; unknown models are cautiously priced like an expensive one). Requests go out with `store: false`.
- Keys are stored encrypted like the Anthropic key (AES-256-GCM) and never sent back to the browser (only the last four characters).

## In the inbox (Conversations)

- **Suggest reply** (next to the channel tabs, also on the contact page): writes a draft for the selected channel (e-mail with salutation and sign-off, SMS short, chat casual) into the text field. Optionally a hint to the AI, e.g. “Offer an appointment on Tuesday”. Nothing is sent until you click **Send**.
- **AI assistant sidebar:** **Summarize** (2–4 sentences plus next step, stays saved), status of the chat bot in this conversation (active / handed over to the team with reason / paused) with **Pause bot** or **Let the bot take over again**, links to the opportunity/task the bot created.
- Messages from the bot and AI drafts are marked purple (“AI assistant” / “AI draft”).

What is sent along: contact data (name, e-mail, phone, company, city, tags, custom fields), open opportunities, the last 20 messages of the conversation, the knowledge and the current time with business-hours status.

## Live chat bot

**Settings → AI assistant → Live chat bot** (the live chat itself must be on under Settings → Live chat):

| Mode | Behavior |
| --- | --- |
| Off | The bot never replies; only suggestions for the team |
| Outside business hours | Replies only outside the entered business hours (time zone of the sub-account); the same time for “from” and “to” = around the clock |
| Always | Replies to every chat message |

Bot replies start with 🤖 in the chat; if someone asks, the bot honestly says it is an AI. It only uses the stored knowledge and doesn't invent prices or promises.

**What the bot knows about the visitor:** only this chat (from the start of the visitor's session) and the name. It does not get e-mails, SMS and other messages of the contact, stored phone number, address or opportunities – someone typing a known e-mail address into the chat has not proven they are that person ([security review, O-2](security-review-2026-10.md#follow-up-fixes-after-0041)). The suggestions for the team in the inbox still see the whole history.

**Handover to the team** – the bot writes the handover text, stays silent in this conversation afterwards, sends an e-mail to the company e-mail (Settings → Company) and fires the workflow trigger **“AI assistant hands over to the team”** when

- the visitor asks for a human (“speak to an employee”, “call me back”, “talk to a human” …),
- a keyword comes up (default: Beschwerde, Reklamation, Anwalt, Kündigung, Datenschutz – i.e. complaint, claim, lawyer, cancellation, data protection; freely changeable),
- the AI itself wants to hand over or is unsure (minimum confidence, default 60%),
- the maximum number of bot replies per conversation is reached (default 8),
- the AI can't be reached, returns an unusable answer, or the monthly limit is reached.

If someone from the team writes in the conversation themselves, the bot stays out for two hours. At most 120 bot replies per hour and sub-account.

**Leads:** if name or e-mail are missing, the bot asks for them (if turned on) and completes the contact – empty fields only, and no e-mail address that another contact already has. When there is buying interest, it creates, if you want, once per conversation an **opportunity** (selected pipeline/stage) and a task “Chat-Lead nachfassen” (follow up the chat lead) and notifies the team.

### Booking appointments

**AI assistant → Live chat bot → Book appointments:** if “Website chat bot may book appointments” is on, the bot gets the free times of the next two weeks of the released calendars (same rules as the booking page and the AI phone agent), can look up a day, and books as soon as the visitor confirms a time and has given first and last name plus e-mail (or phone). The reply contains the confirmation with links to **reschedule** and **cancel**; the confirmation e-mail and the calendar's reminders come as with any booking. The bot never books paid calendars or those with required questions, and at most two bookings per contact and day (adjustable up to 10). Which calendars the AI may book also applies to AI agents with the safety level “Book appointment” and to MCP – details in [booking.md](booking.md#ai-books-appointments).

Technically, the JSON object of the reply then carries a field `booking` (`action`: `none`, `check_slots` or `book`, plus `calendar_id`, `date`, `time`); after a lookup, the server asks the model again with the result (at most three calls per message), and it appends a booked time to the reply itself.

Technically, the model answers every chat message with a fixed JSON object (`reply`, `confidence`, `handoff`, `handoff_reason`, `lead {first_name, last_name, email, phone}`, `buying_intent`, `intent_summary`). The API enforces the schema (Structured Outputs), and the server also checks it strictly: unknown or missing fields, wrong types, invalid e-mail/phone number → no reply but a handover.

## E-mail drafts

With **“Create a reply draft for incoming e-mails”**, every e-mail that arrives through a webhook gets a draft in the conversation (at most 30 per hour). E-mails are **never sent automatically** – check the draft, then **Send** or **Discard**. Mails picked up through IMAP sync or import don't trigger drafts.

## Workflow action “Generate AI text”

A task with placeholders (`{{contact.first_name}}`, `{{contact.custom.<field>}}` …); contact data and the last 10 messages are sent along automatically. The result goes, as you choose,

- into a field (custom fields or company/city/country/website/source) – then use it e.g. in e-mails with `{{contact.custom.<field>}}`,
- as an e-mail draft in the conversation (not sent),
- as a note.

Errors (e.g. limit reached) appear in the log of the workflow run.

## AI phone agent

This assistant answers on the phone too: **Settings → Telephony → AI phone agent** (Twilio required). It uses knowledge, model and monthly limit from here, books appointments, takes messages and forwards calls; every conversation turn and the summary appear under **Usage & limit** as “AI phone agent”. If the limit is reached or the assistant is off, the agent doesn't pick up and normal telephony (forwarding/voicemail) takes over. Setup and flow: [self-hosting.md](self-hosting.md#ai-phone-agent).

## Prompt optimizer

*AI agents → Prompt tests* (with the *Settings* area): test cases for the instructions of an **AI agent**, the **AI phone agent** (persona + instructions) or a **custom prompt** – per case a typical customer message and what a good answer has to do (“says that the first consultation is free”, “doesn't invent opening hours”).

- **Test now:** the model answers every case with the current instructions, and a second, strict call rates the answer (passed yes/no, 0–10 points, reasoning). The result stays saved so the same test can run again after every change. Each case costs two AI calls (purpose `prompt_lab` in the log, same monthly limit); at most 10 cases per test.
- **Suggest an improvement:** from the failed cases, the AI proposes revised instructions with a list of the changes (invented facts are replaced by placeholders such as `[PREIS]`). Nothing changes until you review the proposal and click **Apply** – that goes through the route of the agent or the phone agent (log, undo).
- API: `GET|POST /api/prompt-lab`, `PATCH|DELETE /api/prompt-lab/:id`, `POST /api/prompt-lab/:id/run` (optional `{prompt}` = test a draft without saving), `POST …/improve`, `POST …/apply` `{instructions}`. MCP: `ghl_prompt_tests`, `ghl_prompt_test_run`. Module `server/modules/prompt-lab.ts`.
- Only AI agents you can also see under *AI agents*: nobody else sees a colleague's private agent (and tests on it) – not even an admin; a sub-account API key sees only the shared agents.

## MCP

Tool `ghl_ai_suggest_reply` (`conversation_id` or `contact_id`, optionally `channel`, `instruction`, with an agency key `location_id`): returns `{text, subject, channel}` – sends nothing and counts toward the monthly limit.

## Costs, log and security

- **Every call is logged** (purpose, model, input/output/cache tokens, cost, duration, error) – **Usage & limit** shows the monthly total, a breakdown by purpose and the latest calls. Costs are estimated from Anthropic's list prices; the billing at Anthropic is what counts.
- **Monthly limit:** once it is reached, the assistant refuses further calls (message in the inbox and in the workflow log; the chat bot hands over to the team).
- **Prompt caching:** the fixed rules and the knowledge sit at the front of the system prompt and are cached; repeated requests pay only a fraction for it (visible as “of which from cache”).
- **Secrets:** before sending, API keys, tokens, passwords (“Passwort: …”), card numbers and IBANs are removed from all texts; custom fields with names like `passwort`, `token`, `iban`, `zugang` aren't sent at all.
- **Errors** from Anthropic (invalid key, rate limit, overload, rejected request) appear as a German message; on overload it retries once.
- For Sonnet 5.5 and Opus 5.5, Anthropic's server-side fallback on safety refusals is turned on (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`); if the account doesn't know the beta, it retries without it.

## API

| Method | Path | Area | Purpose |
| --- | --- | --- | --- |
| GET | `/api/ai/status` | all | `{enabled, bot_mode, assistant_name}` |
| GET/PUT | `/api/ai/settings` | Settings | Read/save settings (`api_key` to set, `api_key: null` to remove) |
| POST | `/api/ai/test` | Settings | Check the key (`{api_key?, model?}`) |
| GET/PUT | `/api/ai/provider` | Settings | AI provider `{provider: "" \| anthropic \| openai, openai_model, openai_key}` (key never returned) |
| POST | `/api/ai/provider/test` | Settings | Check the OpenAI key (`{openai_key?, model?}`) |
| GET/PUT | `/api/agency/ai-provider` | Admin | Agency default provider, model and OpenAI key |
| GET | `/api/ai/usage?limit=` | Settings | Monthly total, by purpose, latest calls |
| GET/PUT | `/api/ai-booking/settings` | Settings | Book appointments: `{chat_bot, calendars, per_contact_day}` plus the calendars with `bookable` ([booking.md](booking.md#ai-books-appointments)) |
| POST | `/api/ai/suggest` | Conversations | `{conversation_id \| contact_id, channel?, instruction?}` → `{text, subject, channel}` |
| POST | `/api/ai/summarize` | Conversations | `{conversation_id}` → `{summary, next_step}` |
| GET/PATCH | `/api/ai/conversations/:id` | Conversations | Bot status and summary; PATCH `{bot_status: active \| paused}` |
