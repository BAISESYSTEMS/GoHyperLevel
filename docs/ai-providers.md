# AI providers (BYOK): bring your own key for any model

**Settings → KI-Anbieter (BYOK)** (per sub-account) and **Agency → KI-Anbieter (BYOK)** (for all sub-accounts) are the one place where HyperLevel stores AI connections. Bring your own key for any text model – used by the [HyperLevel Agent](agent.md), the [KI-Assistent](ai-assistant.md) (when routed, see below) and everything built on them – and for image, video and audio providers, which media modules use.

- **Your own ChatGPT or Claude subscription** can be used instead of a key – personally, never shared: [Subscription sign-in](#subscription-sign-in-mit-chatgpt-anmelden-mit-claude-verbinden).
- Keys and extra headers are **sealed** (AES-256-GCM with the server secret) and **never sent back to the browser** – the page shows "…abcd" to people who may edit the connection and "••••" to everyone else.
- Costs run on your account with the provider. HyperLevel logs calls and estimated costs per connection.
- Any model id can always be typed in; where a provider has a model list, HyperLevel loads it live (cached 10 minutes).

## Providers

### Text models

| Provider | Base URL | Auth | Capabilities | Key |
| --- | --- | --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `Authorization: Bearer sk-…` | text, vision, image, TTS, transcription, embeddings | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| Anthropic (Claude) | `https://api.anthropic.com` (Messages API) | `x-api-key: sk-ant-…` + `anthropic-version` | text, vision | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | Bearer `AIza…` | text, vision, image, embeddings | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| OpenRouter | `https://openrouter.ai/api/v1` | Bearer `sk-or-…` | text, vision, image | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) |
| Groq | `https://api.groq.com/openai/v1` | Bearer `gsk_…` | text, transcription | [console.groq.com/keys](https://console.groq.com/keys) |
| Together AI | `https://api.together.xyz/v1` | Bearer | text, vision, image, embeddings | [api.together.ai](https://api.together.ai/settings/api-keys) |
| Fireworks AI | `https://api.fireworks.ai/inference/v1` | Bearer `fw_…` | text, vision, image, embeddings | [fireworks.ai](https://fireworks.ai/account/api-keys) |
| DeepSeek | `https://api.deepseek.com/v1` | Bearer `sk-…` | text | [platform.deepseek.com](https://platform.deepseek.com/api_keys) |
| Mistral AI | `https://api.mistral.ai/v1` | Bearer | text, vision, embeddings, transcription | [console.mistral.ai](https://console.mistral.ai/api-keys) |
| xAI (Grok) | `https://api.x.ai/v1` | Bearer `xai-…` | text, vision, image | [console.x.ai](https://console.x.ai) |
| Perplexity | `https://api.perplexity.ai` | Bearer `pplx-…` | text (with web search; tool calls not on every model) | [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api) |
| Cerebras | `https://api.cerebras.ai/v1` | Bearer `csk-…` | text | [cloud.cerebras.ai](https://cloud.cerebras.ai) |
| Hugging Face (router) | `https://router.huggingface.co/v1` | Bearer `hf_…` | text, vision | [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) |
| Azure OpenAI | `https://<resource>.openai.azure.com` (deployments API, `api-version` 2024-10-21) or `…/openai/v1` (v1 API) | `api-key: …` | text, vision, image, embeddings, TTS, transcription | Azure portal; model = **deployment name** |
| Ollama | `http://localhost:11434/v1` | none | text, vision, embeddings | local – pick a tool-capable model (llama3.1, qwen2.5) for the agent |
| LM Studio | `http://localhost:1234/v1` | none | text, vision, embeddings | local |
| vLLM / LiteLLM proxy | e.g. `http://localhost:4000/v1` | Bearer (proxy key) | text, vision, embeddings, image, TTS, transcription | your proxy |
| Custom (OpenAI-compatible) | any `…/v1` | Bearer, `x-api-key`, `Key …`, a custom header or none | you choose | your server |

**Amazon Bedrock, Google Vertex AI and others** are connected through a [LiteLLM proxy](https://docs.litellm.ai/docs/simple_proxy) (or any OpenAI-compatible gateway): run LiteLLM with your cloud credentials, then add it here as "vLLM / LiteLLM-Proxy" with the proxy's key. HyperLevel never stores cloud IAM credentials.

### More providers: gateways and open-model inference

Checked against each provider's documentation and a live request to its model list or error answer in October 2026 (the `verified` field of every preset). All speak the OpenAI Chat Completions format with `Authorization: Bearer <key>` unless noted; prices are editable estimates, and where a provider's model list states prices HyperLevel shows and uses those ([Model lists and prices](#model-lists-and-prices)).

| Provider | Base URL | Notes | Key | Source |
| --- | --- | --- | --- | --- |
| **OpenRouter** (kept prominent) | `https://openrouter.ai/api/v1` | 400+ models, prices per model in the list; HyperLevel sends `HTTP-Referer` and `X-OpenRouter-Title` (and the older `X-Title`) for app attribution | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) | [docs](https://openrouter.ai/docs/app-attribution) |
| Requesty | `https://router.requesty.ai/v1` | gateway, prices and vision/tool flags in the list; also sends `HTTP-Referer`/`X-Title` | [app.requesty.ai/sign-up](https://app.requesty.ai/sign-up) | [docs](https://docs.requesty.ai/quickstart) |
| Vercel AI Gateway | `https://ai-gateway.vercel.sh/v1` | gateway, ids like `anthropic/claude-sonnet-5.5`, prices in the list | [vercel.com/dashboard/ai-gateway](https://vercel.com/dashboard/ai-gateway) | [docs](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions) |
| Cloudflare Workers AI / AI Gateway | `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1` | replace `{account_id}`; token needs *Workers AI → Read*; ids `@cf/…` (Workers AI) or `author/model` (other providers, billed through Cloudflare); no model list | [dash.cloudflare.com](https://dash.cloudflare.com/profile/api-tokens) | [docs](https://developers.cloudflare.com/ai-gateway/usage/rest-api/) |
| Nebius Token Factory | `https://api.tokenfactory.nebius.com/v1` | open models | [tokenfactory.nebius.com](https://tokenfactory.nebius.com/) | [docs](https://docs.tokenfactory.nebius.com/) |
| Novita AI | `https://api.novita.ai/openai/v1` | open models, prices in the list | [novita.ai](https://novita.ai/settings/key-management) | [docs](https://docs.novita.ai/guides/llm-api) |
| Hyperbolic | `https://api.hyperbolic.xyz/v1` | open models | [app.hyperbolic.ai](https://app.hyperbolic.ai/settings) | [docs](https://www.hyperbolic.ai/docs/inference/quickstart) |
| SambaNova Cloud | `https://api.sambanova.ai/v1` | fast inference, prices in the list | [cloud.sambanova.ai](https://cloud.sambanova.ai/apis) | [docs](https://docs.sambanova.ai/docs/en/features/openai-compatibility) |
| Featherless | `https://api.featherless.ai/v1` | 20 000+ open models (list is searched, gated models hidden) | [featherless.ai](https://featherless.ai/account/api-keys) | [docs](https://featherless.ai/docs/api-overview-and-common-options) |
| Venice | `https://api.venice.ai/api/v1` | privacy-oriented; prices per million tokens in the list | [venice.ai/settings/api](https://venice.ai/settings/api) | [docs](https://docs.venice.ai/overview/getting-started) |
| Moonshot AI (Kimi) | `https://api.moonshot.ai/v1` | international platform; processing at Moonshot, not in the EU | [platform.kimi.ai](https://platform.kimi.ai/console/api-keys) | [docs](https://platform.kimi.ai/docs/guide/start-using-kimi-api) |
| Zhipu GLM (Z.ai) | `https://api.z.ai/api/paas/v4` | general API only – the "GLM Coding Plan" has its own access for coding tools and is **not** used here; no model list | [z.ai](https://z.ai/manage-apikey/apikey-list) | [docs](https://docs.z.ai/guides/overview/quick-start) |
| Alibaba Qwen (Model Studio) | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | keys are regional; newer accounts use `https://<workspace>.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` or `https://dashscope-us.aliyuncs.com/compatible-mode/v1` – edit the address; no model list | [Model Studio](https://modelstudio.console.alibabacloud.com/) | [docs](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope) |
| MiniMax | `https://api.minimax.io/v1` | no model list; M3.1-Flash-Preview is not on this API (M Plan / MiniMax Code only) | [platform.minimax.io](https://platform.minimax.io/user-center/basic-information/interface-key) | [docs](https://platform.minimax.io/docs/api-reference/text-openai-api) |
| Cohere (compatibility API) | `https://api.cohere.ai/compatibility/v1` | chat with tools, embeddings; unsupported: `n`, `logit_bias`, `parallel_tool_calls` | [dashboard.cohere.com](https://dashboard.cohere.com/api-keys) | [docs](https://docs.cohere.com/docs/compatibility-api) |
| AI21 (Jamba) | `https://api.ai21.com/studio/v1` | `jamba-large`, `jamba-mini`; at most 4096 output tokens | [docs.ai21.com](https://docs.ai21.com/docs/create-api-key) | [docs](https://docs.ai21.com/reference/jamba-1-6-api-ref) |
| **kie.ai (chat)** | `https://api.kie.ai/anthropic` (Anthropic Messages API, `Authorization: Bearer`) | Claude models with Anthropic's ids, same key as the kie.ai media preset. kie.ai's GPT and Gemini chat models have **one address per model** (`https://api.kie.ai/<model>/v1/chat/completions`) – add them as *Benutzerdefiniert* if you need them | [kie.ai/api-key](https://kie.ai/api-key) | [docs](https://docs.kie.ai/ai-agent/claude-code.md) |

Mistral AI (`https://api.mistral.ai/v1`) and the OpenAI-compatible providers of the table above are unchanged; Mistral's list was re-checked and the EU endpoint was added (next section).

### EU hosting (DSGVO)

The cards **IONOS**, **STACKIT**, **OVHcloud**, **Scaleway** and **Mistral AI – EU-Endpunkt** carry an **EU-Hosting** badge and the filter *EU-Hosting* in the gallery. The badge appears only where the provider's own documentation says where data is processed – hover it for the statement and the page it comes from:

| Provider | Base URL | What the provider says | Source |
| --- | --- | --- | --- |
| IONOS AI Model Hub | `https://openai.inference.de-txl.ionos.com/v1` | "data processing is confined within Germany"; inputs are not used for training. Token from the Data Center Designer (*Management → Token Manager*); new customers need a Public Cloud contract first | [docs](https://docs.ionos.com/cloud/ai/ai-model-hub/ai-model-hub.md) |
| STACKIT AI Model Serving | `https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1` | "fully hosted in European data centers and strictly GDPR-compliant"; requests are not stored. Auth token from the STACKIT portal | [stackit.com](https://stackit.com/en/products/data-ai) |
| OVHcloud AI Endpoints | `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1` | infrastructure "located in Gravelines, France"; data "not stored or shared". The product page lists availability as "Worldwide (non-EU)" – check that your country is covered | [docs](https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-capabilities) |
| Scaleway Generative APIs | `https://api.scaleway.ai/v1` | "Hosted in European data centers" | [docs](https://www.scaleway.com/en/docs/generative-apis/quickstart.md) |
| Mistral AI – EU-Endpunkt | `https://api.eu.mistral.ai/v1` | regional inference in data centers in the EU and EFTA; **+10 %** price; no Agents, Batch or Files API, function calling only; account, billing and API keys stay with Mistral outside that region | [docs](https://docs.mistral.ai/inference/regional-inference.md) |

*Mistral AI* (global endpoint) is **not** badged: "Mistral does not commit to a specific inference location for requests sent to this endpoint". The badge is information, not legal advice: it does not cover where a provider keeps account data, and you still need a data-processing agreement with the provider. IONOS and STACKIT also sell dedicated models; this list covers their shared, pay-per-token endpoints.

### Image, video and audio

| Provider | Base URL | Auth | Capabilities | Key |
| --- | --- | --- | --- | --- |
| fal.ai | `https://fal.run` (queue: `https://queue.fal.run`) | `Authorization: Key <key>` | image, video, TTS, music, transcription | [fal.ai/dashboard/keys](https://fal.ai/dashboard/keys) |
| kie.ai | `https://api.kie.ai` | Bearer | image, video, music | [kie.ai/api-key](https://kie.ai/api-key) |
| Replicate | `https://api.replicate.com/v1` | Bearer `r8_…` | image, video, TTS, music, transcription | [replicate.com](https://replicate.com/account/api-tokens) |
| Stability AI | `https://api.stability.ai` | Bearer `sk-…` | image, music | [platform.stability.ai](https://platform.stability.ai/account/keys) |
| ElevenLabs | `https://api.elevenlabs.io` | `xi-api-key: …` | TTS, music, transcription | [elevenlabs.io](https://elevenlabs.io/app/settings/api-keys) |
| Runway | `https://api.dev.runwayml.com/v1` | Bearer + `X-Runway-Version` | video, image | [dev.runwayml.com](https://dev.runwayml.com/) |
| Luma AI | `https://api.lumalabs.ai/dream-machine/v1` | Bearer | video, image | [lumalabs.ai/api/keys](https://lumalabs.ai/api/keys) |
| Custom (HTTP) | any | any style | you choose | – |

### Speech (voice layer)

Providers for the [voice layer](voice.md) – the phone agent's own voice, push-to-talk, spoken replies, voicemail transcription. They are ordinary media connections with the capabilities *Sprachausgabe* (`audio_tts`) and *Transkription* (`stt`); cards marked **Live** can stream into a phone call.

| Provider | Base URL | Auth | Capabilities | Live |
| --- | --- | --- | --- | --- |
| Deepgram (Nova & Aura) | `https://api.deepgram.com` (EU: `api.eu.deepgram.com`) | `Authorization: Token …` | STT, TTS | STT and TTS |
| Cartesia (Sonic) | `https://api.cartesia.ai` | `X-API-Key` + `Cartesia-Version` | TTS, STT | TTS |
| AssemblyAI | `https://api.assemblyai.com` (EU: `api.eu.assemblyai.com`) | `Authorization: <key>` | STT | STT |
| Azure Speech | your resource address, e.g. `https://germanywestcentral.api.cognitive.microsoft.com` | `Ocp-Apim-Subscription-Key` | TTS, STT | TTS |
| Google Cloud Speech | `https://texttospeech.googleapis.com` | `X-Goog-Api-Key` | TTS, STT | TTS |
| Local speech server | e.g. `http://localhost:8880/v1` (Kokoro-FastAPI, openedai-speech, Speaches, whisper.cpp) | optional | TTS, STT | TTS |

OpenAI, ElevenLabs and Gemini gained speech capabilities and voices too (see the table in [voice.md](voice.md#providers)). The auth style *Token* (`Authorization: Token <key>`) is new for Deepgram.

Media connections only store the key, address and default models; the generation itself is done by the media modules, which read the connection with `app.services.aiConnections.resolve(locationId, 'image' | 'video' | 'audio_tts' | 'audio_music' | 'stt')`.

## Add a connection

1. Click a provider card. Enter the key (and the address for Azure, local servers and custom ones).
2. Choose capabilities and a **default model per capability** – pick from the live list (**Liste laden**) or type any id.
3. **Verbindung testen** loads the model list (no tokens) and, for text, sends one tiny request with a test tool to check that tool calling works (the agent needs it). Unsaved changes in the form are tested too; the result is stored on the connection (*geprüft*, *Hinweis*, *Fehler*).
4. **Erweitert:** auth style and header name (media providers: also the key as URL parameter), extra headers (e.g. `OpenAI-Organization`; values sealed, empty = keep), prices per million tokens (for cost tracking and the monthly limit), the Azure API version; for media providers a **webhook secret** (kie.ai: `webhookHmacKey`) so signed callbacks can be checked, and for *Benutzerdefiniert (HTTP)* an optional request template.

**Local networks.** Addresses on `localhost`, private IPs or `.local`/`.internal` names are refused unless an **agency admin** ticks "Lokales Netz erlauben" on that connection (e.g. Ollama on the same server). Every request to a user-entered address resolves DNS and refuses private targets otherwise (no DNS rebinding), and redirects are not followed. Internet addresses must use `https://`.

**Who may do what.** People with the *Einstellungen* area manage the sub-account's connections and routing. Agency connections and the agency routing: admins only. Members see agency connections (name, provider, capabilities), never their keys.

## Model lists and prices

**Modelle & Preise** on a connection card (and the live list in the connection form) loads the provider's `GET /models` (cached 10 minutes) with a search box – the list of Featherless alone has more than 20 000 models, so the server filters before it sends (at most 1500 rows). Where the provider's list says so, every row shows context size, vision and tool support and the **price per million input and output tokens** (US dollars):

| Provider | Where the list states prices |
| --- | --- |
| OpenRouter | `pricing.prompt` / `pricing.completion` (per token, free models and routers handled) |
| Vercel AI Gateway | `pricing.input` / `pricing.output` (per token), language models only |
| Requesty | `input_price` / `output_price` (per token), `supports_vision`, `supports_tool_calling` |
| Novita AI | `pricing.prompt.price_per_m_decimal` (per million) |
| Venice | `model_spec.pricing.input.usd` (per million) and capabilities |
| SambaNova, OVHcloud, Featherless | `pricing.prompt` / `pricing.completion` (per token); OVHcloud's embeddings, speech and image models are left out, Featherless' gated models too |

The other providers send ids only (Together, Groq, … state prices in their console). The cost estimate of a call uses, in this order: the prices typed into the connection (*Erweitert*), the price the provider's list stated for that model (once the list was loaded in this server process), the preset's rough estimate. **Verbindung testen** works for providers without a model list too: a 404 on `/models` is not an error, HyperLevel then checks with one tiny chat request.

## Subscription sign-in (Mit ChatGPT anmelden, Mit Claude verbinden)

At the top of **Einstellungen → KI-Anbieter → Mit deinem Abo** two big cards let a person use their own subscription instead of an API key.

| | Mit ChatGPT anmelden | Mit Claude verbinden |
| --- | --- | --- |
| What | ChatGPT Plus / Pro / Team plan as a model for *your own* agent chats, assistant actions and Werkstatt builds | Claude Pro / Max through **Claude Code on your own computer** (the [bridge](#the-local-bridge-claude-code-and-codex-cli)) |
| How | OpenAI's official "Sign in with ChatGPT" for open-source apps: sign in at OpenAI, paste the address the browser lands on | one command on your computer, a pairing code (and QR code), live status, your model |
| Where the login lives | sealed in HyperLevel's database, per user | only on your computer – HyperLevel never sees it |
| Status | **implemented** (default on for self-hosted installs, off on a hosted service until OpenAI approves) | **bridge** is the supported way; **no OAuth sign-in exists, on purpose** |

### Legal position (researched October 2026)

**ChatGPT – allowed for open-source and self-hosted apps, with OpenAI's own flow.** OpenAI documents a flow for exactly this: *"ChatGPT plan usage is available to open-source projects, personal projects that run locally, and selected private apps."* An open-source app registers itself dynamically (`client_id=dynamic_agent_client`, its name and an installation id, no client secret and no partner key), and the user authorizes it for `chatgpt.tokens.use.direct`. The tokens pay for Responses API requests at `https://api.openai.com/v1/responses` out of the user's plan (`store: false`, `stream: true`, no `max_output_tokens`/`temperature`; function tools grouped in a namespace). *"If you're building a paid or remotely hosted app, join the waitlist to request access before offering it to users."* So:

- **Self-hosted HyperLevel** (AGPL, your own server, your own team): the feature is on by default; an agency admin can switch it off.
- **HyperLevel run as a paid or hosted service for other people** (set `PGHL_HOSTED=1`): the feature is **off** until the operator has OpenAI's approval and sets `PGHL_CHATGPT_SIGNIN_APPROVED=1`. The cloud edition's operator needs that approval before turning it on.
- HyperLevel does **not** borrow the Codex CLI's client id (as some other tools do) and does not talk to ChatGPT's `backend-api`; OpenAI's documentation says that route is not the supported one.
- OpenAI asks apps to say clearly when the plan is in use and to link to *chatgpt.com → Settings → Usage*: both are in the chat ("Dein ChatGPT-Abo · Nutzung ↗") and on the card.

Sources: [overview](https://developers.openai.com/siwc/token-sharing-open-source) · [registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) · [accounts, sessions, refresh, revoke](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) · [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) · [errors](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery) · [cookbook](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt) · [reference implementation](https://github.com/openai/sign-in-with-chatgpt-devkit).

**Claude – not allowed for third parties, so there is no flow.** Anthropic's Claude Code documentation says: *"Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."* Developers should use API keys from the Claude Console. The same page confirms that an end user may sign in to the **unmodified Claude Code** with their own subscription. The [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) (effective 8 Oct 2025) also forbid automated access except with an API key and sharing account credentials. HyperLevel therefore ships **no** "Mit Claude anmelden", never stores a Claude.ai token, and offers two compliant ways: Claude Code on your own computer (recommended) or an **Anthropic API key** from the Console. The button is called *Mit Claude verbinden* on purpose: the sign-in happens in Claude Code, not in HyperLevel. Sources: [Legal and compliance → Authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use), [Authentication](https://code.claude.com/docs/en/authentication).

**How other tools handle it** (for comparison): OpenCode is a launch partner of OpenAI's flow above; Hermes Agent signs in with a device-code login using the Codex CLI's client and supports Claude only through an API key or – on a Max plan with extra usage credits – by presenting itself as Claude Code, which Anthropic's wording above does not allow third parties to do. HyperLevel follows the documented routes only.

### Mit ChatGPT anmelden – step by step

1. *Anmeldung starten* – HyperLevel builds the authorize URL (PKCE S256, fresh `state` and `nonce`, `resource=https://api.openai.com/v1`, scopes `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, `ext_agent_host_id` = one `urn:uuid:…` per installation, `agent_name_hint` = the app name on the very first sign-in only). The PKCE verifier stays on the server.
2. *ChatGPT öffnen* – the person signs in at OpenAI, picks the workspace and allows the use of their plan.
3. OpenAI only allows a **loopback redirect on `127.0.0.1`** (`http://127.0.0.1:1455/auth/callback`) – on a web server that is the person's own computer, where nothing listens. The browser shows "Seite nicht erreichbar"; the person **pastes the whole address** from the address bar. (OpenAI describes the same situation for remote machines: complete the sign-in where the browser is, then hand over.) The code in it is single use and worthless without the verifier.
4. HyperLevel validates `state`, exchanges the code (the same redirect URI and resource, no secret), **verifies the ID token** (RS256 against OpenAI's JWKS, issuer, audience = the issued client id, expiry, nonce), checks that the plan scope was granted, loads the model list (`GET /v1/models`) and picks the first model. If the person declined the plan scope, the tokens are revoked and dropped and the next attempt asks for consent again (`prompt=consent`).

**Plan and expiry** are shown on the card: the account's e-mail, the plan when OpenAI's ID token names it (otherwise "wird von ChatGPT verwaltet"), *Anmeldung gültig bis* (refresh tokens live 30 days from the last use and renew with every refresh), and when the current access token (1 hour) runs out. **Refresh is automatic**: two minutes before expiry, one refresh at a time per person (the refresh token rotates), the new tokens are stored before anything else. An unusable refresh token (`invalid_grant`, `refresh_token_reused`, expired, revoked in ChatGPT) ends the sign-in with the status *Abgelaufen* – the person signs in again and the saved client registration is reused. A temporary outage keeps the sign-in. HyperLevel never refreshes in the background for people who do not use it: a sign-in unused for 30 days expires.

**Disconnect** revokes the refresh token at OpenAI's revocation endpoint (the answer says whether OpenAI confirmed), deletes the tokens and keeps only the registration (client id) for the next sign-in. People can also remove the app in ChatGPT under *Settings → Usage*.

### Safety rules – a subscription is personal

- **Only the owner's browser session** can use it. Not other users, **not the agency admin**, not API keys, agency keys, MCP or app tokens (`403`), not a custom agent (its model cannot be set to the subscription), not anyone with access to the database (tokens are sealed with the server secret, AES-256-GCM, and never sent to the browser or written to a log).
- **Only for what the owner switched on** (three switches on the card): *Meine KI-Agent-Chats* – only chats the owner types in the browser (`connection: "sub:chatgpt"`, shown as "Mein ChatGPT-Abo" in the model picker); *Meine KI-Assistent-Aktionen* – reply suggestions, summaries and the AI helpers in Canvas, Boards, Wiki and Ads that the owner triggers; *Meine Werkstatt-Aufträge* – builds the owner starts, **only with a model that passes the Werkstatt model gate** (a separate Werkstatt model can be chosen; otherwise the sub-account's routing and its gate apply).
- **Never anything unattended**: workflows, schedules, auto-replies, the chat bot, e-mail drafts, the phone agent, video recycling, app dictation, MCP calls and background jobs always use the sub-account's own connections. (`resolveFor` requires a person, `automatic = false` and a browser session; `aiRun` accepts only the listed assistant purposes.)
- The token is only ever sent to `https://api.openai.com/v1/…`.
- **Usage limits**: calls count on the person's ChatGPT plan (on Plus one five-hour limit is shared by all apps), on the sub-account's monthly token limit and appear in the usage log with cost 0. When ChatGPT answers that the limit is reached, HyperLevel says so and links to *chatgpt.com/settings/usage*.
- **Admins** switch the feature off per agency (checkbox on the card, `PUT /api/ai-subscriptions/admin`); everything stops at once, saved sign-ins stay sealed and work again when it is switched back on.
- **Audit log** (*Agentur → Protokoll*): `ai.subscription.start`, `.connect` ("ChatGPT-Abo verbunden (Plan: ChatGPT Plus)"), `.disconnect` ("… Widerruf bei OpenAI bestätigt"), `.expired`, `.admin`. Never a token, an authorization code, an address with a code in it or an e-mail address.

**Honest status.** The flow is implemented from OpenAI's published specification and reference code and covered by tests with a faked OpenAI (PKCE, registration, loopback paste, token rotation, revocation, ID-token verification, the Responses stream and its error codes). It has not been run against a live ChatGPT account in this repository's tests; connect one real account once before relying on it, in particular the namespaced tool format of the Responses route, which OpenAI documents only briefly.

### The local bridge (Claude Code and Codex CLI)

*Mit Claude verbinden* (and *Oder: über die Codex CLI auf deinem Rechner* under the ChatGPT card) opens the bridge dialog:

1. Install and sign in to **Claude Code** (`npm i -g @anthropic-ai/claude-code`, then `claude`) or the **Codex CLI** (`npm i -g @openai/codex`, `codex login`) on your own computer.
2. *Verbindungs-Code erzeugen* – a code that is valid 10 minutes and once, with a **copyable one-line command** (macOS/Linux and Windows PowerShell tabs): it downloads `gohigh-bridge.mjs` from your HyperLevel, pairs and starts it. A **QR code** carries the pairing command so it can be scanned with a phone and sent to the computer. (Node 18+ and curl are all it needs; the script has no dependencies.)
3. **Live status** (refreshes every 4 seconds while the dialog is open): ● *Verbunden* / ○ *Offline*, the computer's name, last seen, version, and per computer the program (Claude Code or Codex CLI) and the **model** – passed to the CLI as `--model` / `-m` (leave empty for the CLI's default; only ids that look like model ids are passed on).
4. In the agent chat choose the model **"Mein Abo über die Bridge"**.

**Limits, said plainly in the dialog:** it only works while your computer is on and the bridge runs; it is for you personally (not for automations, workflows or other people); it counts on your Claude or ChatGPT plan. The CLI works with HyperLevel's tools only (file, shell and web tools are switched off), with your rights and your agent's confirmations in the web chat. The bridge reconnects by itself after network trouble or a restart of HyperLevel (1 s, then longer, up to a minute) and keeps waiting while an agency admin has switched it off; an unpaired bridge stops with a clear message. `node gohigh-bridge.mjs status` checks the pairing. An agency admin has to allow the bridge first (the dialog has the switch for admins).

**Start it at login** (optional):

```
# Linux: ~/.config/systemd/user/gohigh-bridge.service   →   systemctl --user enable --now gohigh-bridge
[Unit]
Description=HyperLevel Bridge
After=network-online.target
[Service]
ExecStart=/usr/bin/env node %h/gohigh-bridge.mjs
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
```

macOS: a LaunchAgent (`~/Library/LaunchAgents/org.gohigh.bridge.plist`) with `ProgramArguments` = `node`, the script path and `KeepAlive` = true. Windows: Task Scheduler → *At log on* → `node C:\path\gohigh-bridge.mjs`. If `claude` or `codex` is not on that service's `PATH`, set `GOHIGH_CLAUDE_BIN` / `GOHIGH_CODEX_BIN`.

### Settings and environment

| | |
| --- | --- |
| Agency switch | *Einstellungen → KI-Anbieter → Mit deinem Abo* → "Mit ChatGPT anmelden für diese Agentur erlauben" (admins) |
| `PGHL_SUBSCRIPTION_SIGNIN=off` | Operator switch: no subscription sign-in on this server |
| `PGHL_HOSTED=1` | This installation is run as a hosted or paid service for others: ChatGPT sign-in is off until approved |
| `PGHL_CHATGPT_SIGNIN_APPROVED=1` | OpenAI has approved this hosted service ([interest form](https://openai.com/form/sign-in-with-chatgpt-interest/)) – turns the sign-in back on |

## Skipped and partly covered providers

| Provider | Status |
| --- | --- |
| **Lambda Inference API** | **Skipped.** Third-party sources report that Lambda announced the wind-down of its Inference API in May 2026 in favour of self-hosted deployments on Lambda GPUs; `api.lambda.ai` did not answer from our environment and `docs.lambda.ai` could not be verified. Use the *vLLM / LiteLLM* preset with a Lambda GPU instance instead. |
| kie.ai GPT and Gemini chat models | Each model has its own address (`https://api.kie.ai/<model>/v1/chat/completions`), which does not fit one preset. The Claude models (Anthropic API at `/anthropic`) are a preset; the others work as *Benutzerdefiniert* connections. |
| Cloudflare AI Gateway `/compat` URL | Deprecated for single-model calls by Cloudflare; the preset uses the REST endpoint (`…/accounts/{account_id}/ai/v1`) that serves Workers AI and third-party models. |
| Alibaba Qwen, Zhipu GLM, MiniMax, Cohere, AI21 | Verified (see the table above) but they have no usable `GET /models`; the suggestions are fixed and every id can be typed. |

## Routing: which model for what

| Usage | Used by |
| --- | --- |
| KI-Agent (Chat & Werkzeuge) | the HyperLevel Agent (unless a custom agent or the chat picks another) |
| Schnelle KI-Texte | the KI-Assistent's `aiRun`: reply suggestions, chat bot, e-mail drafts, workflow "KI-Text", phone agent, video recycling, mobile capture |
| Zusammenfassungen | the KI-Assistent's summaries (falls back to "Schnelle KI-Texte") |
| Workflows | the [KI-Workflow-Builder](workflow-ai.md) (*Mit KI erstellen / ändern* in Automationen; falls back to "Schnelle KI-Texte", then to the KI-Assistent's own provider) – a strong model pays off here |
| Funnel & Website AI | the [Funnel & Website AI](site-ai.md) (*Mit KI erstellen* in Funnels & Websites, the builder's AI panel, the AI writer for blog posts and e-mail text blocks; falls back to "Schnelle KI-Texte", then to the KI-Assistent's own provider) |
| Werkstatt | plans, builds and changes of plugins and core specifications (falls back to "Schnelle KI-Texte"); only a top model passes the Werkstatt's model gate |
| Werkstatt: Zweitmeinung | the second reviewer before a plugin goes to the Marktplatz (Pro) – no fallback, and a different model than the one that built it |
| Embeddings, Bilder, Videos, Sprachausgabe, Musik, Transkription | media and search modules |

**Ersatzmodelle** (text usages): under the model of a routed text usage up to five fallback model ids of the same connection – tried in order when the model is busy or broken (5xx, 429, overloaded, kie.ai *no_available_account*, timeout), then the other text connections. Empty = the provider's default order (kie.ai: `claude-sonnet-5-5 → claude-sonnet-5 → claude-haiku-5-5`). Details: [agent.md](agent.md#ersatzmodelle).

## Denkstufe (reasoning effort)

*Einstellungen → KI-Anbieter → Denkstufe* sets how hard the models think: one default (built in: `xhigh`) and an optional
level per capability (agent, Werkstatt, review, quick texts, summaries, phone agent), for the agency and – overriding it –
per sub-account (`GET|PUT /api/ai-effort`, [docs/api.md](api.md#werkstatt-plugins-and-marktplatz)). The adapters send it as
`output_config.effort` (Anthropic), `reasoning.effort` (OpenAI Responses), `reasoning_effort` (Chat Completions) or
`reasoning: { effort }` (OpenRouter); a model that cannot take the level gets its highest one and the log says so
(„xhigh → high, vom Modell nicht unterstützt“). The Werkstatt never goes below `high`. Details and the model table:
[docs/werkstatt.md](werkstatt.md#denkstufe-reasoning-effort), `server/services/ai-effort.ts`.

`resolve(locationId, usage)` picks, first match wins: the connection asked for explicitly → the **sub-account's routing** → the **sub-account's own connections** with that capability → the **agency routing** → **agency connections** → keys the KI-Assistent already has (implicit, read-only: its Anthropic key, the OpenAI provider of the KI-Werkzeuge, `PGHL_ANTHROPIC_API_KEY`, `PGHL_OPENAI_API_KEY`).

**Quick texts stay with the KI-Assistent until you route them.** Only an explicit routing for *Schnelle KI-Texte* / *Zusammenfassungen* (sub-account or agency) moves `aiRun` to a registry connection – then every existing consumer works with any text provider: OpenAI and Azure with JSON schema, the others with JSON mode plus an instruction; the JSON object is cut out of the reply. Settings → KI-Assistent shows a note when its texts are routed. Monthly limit and usage log stay per sub-account.

## Usage and costs

Each call through a connection is counted per day and sub-account (calls, tokens, estimated cost); the page shows the current month per connection. Agent and quick-text calls also land in the KI-Assistent's usage log and count on its monthly limit. Media providers bill per generation – their costs are shown by the provider.

## For developers

```ts
const reg = app.services.aiConnections;
reg.list(locationId, capability?)              // connections the sub-account can use, without secrets
reg.resolve(locationId, capabilityOrUsage, id?) // → { connectionId, provider, baseUrl, apiKey, headers, authStyle, model, label, wire, capabilities, options, webhookSecret? } | null
await reg.models(connectionId, locationId?, { refresh?, q? }) // → { models, details: [{id, name?, context?, in?, out?, free?, vision?, tools?}], total, live, cached, free_text: true, error? }
reg.fetchFor(resolved)                          // fetch with the SSRF guard for user-entered addresses
reg.recordUsage(connectionId, locationId, usage, costMicros)
```

The personal subscription lives in `app.services.aiSubscriptions` (`modules/ai-subscriptions.ts`) and is deliberately **not** part of `resolve()`: `resolveFor({user, locationId, usage: 'agent' | 'assistant' | 'werkstatt', automatic, via})` returns a `Resolved` with `provider: 'chatgpt_plan'`, `wire: 'responses'`, **no key and no headers** (`fetchFor(resolved)` adds the access token per request, refreshing when needed, and refuses any URL outside `https://api.openai.com/v1/`), or `null`; `providerFor({locationId, purpose, userId})` is what `aiRun` asks (through `app.services.aiProvider(locationId, purpose, userId)`); `chatModelsFor(user, locationId)` feeds the chat's model picker. The wire `responses` (`services/chatgpt-responses.ts`) registers itself in `services/agent-llm.ts` (`extraWires`), so `chatWithTools` and `completeText` need nothing else. Pure protocol code: `services/chatgpt-oauth.ts`; model-list parsing with prices: `services/ai-model-info.ts`; the extra presets: `services/ai-presets-extra.ts` (`eu`, `tags`, `infoKind`, `referral`, `verified` fields). Test hooks: `app.services.aiSubscriptionsFetch` (every request to `auth.openai.com` and `api.openai.com`), `app.services.aiConnectionsFetch`; tests: `tests/ai-subscriptions.test.ts`, `tests/chatgpt-oauth.test.ts`, `tests/ai-providers-catalog.test.ts` (fixtures: `tests/fixtures/ai-models/`), `tests/bridge-connect.test.ts`, fake service `tests/chatgpt-fakes.ts`.

`headers` already contains the auth header in the connection's style, the preset's fixed headers and the user's extra headers. `authStyle` says how the key is sent: `bearer`, `key` (`Authorization: Key <key>`, fal.ai), `header:<name>` (e.g. `header:xi-api-key`, `header:x-api-key`, `header:api-key`), `query:<name>` (custom HTTP only – the caller appends `?<name>=<key>`; the key is then *not* in `headers`) or `none`. `wire` is `openai` (Chat Completions), `anthropic` (Messages API) or `http` (media). `webhookSecret` is the provider's callback signing secret (kie.ai `webhookHmacKey`), stored sealed and write-only like the key; `options.template` is the request template of a *Benutzerdefiniert (HTTP)* connection (JSON object with `url`, `method`, `headers`, `body`, `result_path`, `poll` …, at most 16 KB – the KI-Studio docs describe it). `list()` entries carry `id`, `provider`, `label`, `capabilities`, `models` and `model` (the default for the capability asked for). Tables: `ai_connections`, `ai_routing`, `ai_connection_usage`. Presets: `server/services/ai-presets.ts`. Test hook: `app.services.aiConnectionsFetch`.

API (session or sub-account key, area *Einstellungen*): `GET /api/ai-connections/presets`, `GET /api/ai-connections` (connections, routing, usage), `POST /api/ai-connections` `{scope: location|agency, provider, label, base_url, api_key, auth_style: bearer|x-api-key|key|header|query|none, auth_header, extra_headers, webhook_secret, capabilities, models: {text, image, …}, enabled, options: {price_in, price_out, api_version, allow_private, template}}`, `PATCH/DELETE /api/ai-connections/:id`, `GET /api/ai-connections/:id/models?refresh=1`, `POST /api/ai-connections/test` `{id | draft…, deep?, capability?, model?}`, `PUT /api/ai-connections/routing` `{scope, usage, connection_id, model, fallbacks?: [model…] | "a, b"}` (fallbacks kept while the routing stays on the same connection).

Subscription sign-in (browser session only – API keys get `403`): `GET /api/ai-subscriptions` (availability, the caller's own ChatGPT connection without secrets, uses, bridge status), `GET /api/ai-subscriptions/overview` (availability and the caller's own connection – used by the MCP tool), `POST /api/ai-subscriptions/chatgpt/start` → `{authorize_url, redirect_uri, expires_at}`, `POST …/chatgpt/complete` `{callback: "<pasted address>"}`, `PATCH …/chatgpt` `{model?, werkstatt_model?, uses?: {agent, assistant, werkstatt}}`, `GET …/chatgpt/models`, `POST …/chatgpt/test` `{deep?}`, `DELETE …/chatgpt`; admins: `GET|PUT /api/ai-subscriptions/admin` `{chatgpt: boolean}`. Bridge additions: `PATCH /api/agent/bridge/devices/:id` takes `model`; `POST /api/agent/bridge/code` returns `command_oneline`, `command_windows`, `qr_svg`, `expires_in_s`. MCP tool **`ghl_ai_providers`** (`location_id`, `filter: eu|cheap|fast|local|gateway`, `search`): providers, the sub-account's connections without keys, effective routing and the sign-in availability – no secrets.
