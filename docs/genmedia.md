# AI media generation (KI-Studio)

Create **images, videos, music, text-to-speech and transcripts** with your own AI provider – any model it offers. HyperLevel never resells AI: you connect your own key (BYOK, *bring your own key*) and pay the provider directly. Results are downloaded and kept in HyperLevel, so provider links may expire without breaking your e-mails, funnels or posts.

Where: **Marketing → KI-Studio** (tabs *Bild*, *Video*, *Audio*, *Sprache*, *Eigene Anbieter*), the **KI-Bild generieren** button in the e-mail builder, funnel builder, social planner composer and blog/course/community image fields, three workflow actions, five MCP tools and the mobile API.

## Connect a provider (BYOK)

Keys live in the shared AI connection registry: **Settings → KI-Anbieter (BYOK)** (one place for every AI feature of a sub-account). The KI-Studio asks the registry for a connection each time it calls a provider (`app.services.aiConnections.resolve(locationId, capability, connectionId?)`) and never stores keys in jobs, logs or the browser. Without a connection every screen, tool and action says: *„Bitte zuerst unter Einstellungen → KI-Anbieter (BYOK) einen Anbieter verbinden“*.

Capabilities: `image`, `video`, `audio_tts` (text to speech), `audio_music` (music & sound) and `stt` (speech to text). A connection may serve several of them; the model field always accepts free text, so new models work the day they ship.

## Providers

| Provider (preset id) | Can do | Auth (default) | Endpoints used | Example model ids |
| --- | --- | --- | --- | --- |
| **fal.ai** (`fal`) | image, video, TTS, music, STT | `Authorization: Key …` | `POST https://queue.fal.run/{model_id}` (+ `?fal_webhook=`), `GET …/requests/{id}/status`, `GET …/requests/{id}`, `PUT …/cancel` | `fal-ai/flux/dev`, `fal-ai/flux-pro/v1.1-ultra`, `fal-ai/nano-banana-2`, `fal-ai/flux-pro/kontext`, `fal-ai/veo3.1`, `fal-ai/kling-video/v2.5-turbo/pro/image-to-video`, `fal-ai/sora-2/text-to-video`, `fal-ai/minimax/speech-02-hd`, `fal-ai/elevenlabs/tts/multilingual-v2`, `fal-ai/wizper` |
| **kie.ai** (`kie`) | image, video, TTS, music, STT | `Bearer` | Market: `POST /api/v1/jobs/createTask` `{model, callBackUrl, input}`, `GET /api/v1/jobs/recordInfo?taskId=`; own endpoints: Veo 3 `/api/v1/veo/generate` + `/record-info`, Runway `/api/v1/runway/generate` + `/record-detail`, GPT-4o image `/api/v1/gpt4o-image/generate`, Flux Kontext `/api/v1/flux/kontext/generate`, Midjourney `/api/v1/mj/generate`, Suno `/api/v1/generate` (+ `/record-info`) | `veo-3-1`, `runway`, `kling-2.6/text-to-video`, `google/nano-banana`, `4o-image-api`, `flux1-kontext`, `ai-music-api/generate` (Suno), `elevenlabs/text-to-speech-multilingual-v2`; own endpoints: `veo3_fast`, `veo3`, `runway-gen3`, `gpt4o-image`, `flux-kontext-pro`, `flux-kontext-max`, `midjourney`, `suno-V4_5`, `suno-V5` |
| **Replicate** (`replicate`) | image, video, TTS, music, STT | `Bearer` | `POST /v1/models/{owner}/{name}/predictions` or `POST /v1/predictions {version}`, `GET /v1/predictions/{id}`, `POST …/cancel`, `GET /v1/webhooks/default/secret` | `black-forest-labs/flux-schnell`, `black-forest-labs/flux-1.1-pro-ultra`, `google/nano-banana`, `google/veo-3-fast`, `kwaivgi/kling-v2.1`, `minimax/speech-02-hd`, `owner/name:version` for community models (e.g. Whisper, MusicGen) |
| **OpenAI** (`openai`) | image, video (Sora), TTS, STT | `Bearer` | `POST /v1/images/generations`, `POST /v1/images/edits` (JSON, reference image), `POST /v1/videos` + `GET /v1/videos/{id}` + `GET …/content`, `POST /v1/audio/speech`, `POST /v1/audio/transcriptions` | `gpt-image-1`, `gpt-image-1-mini`, `gpt-image-1.5`, `sora-2`, `sora-2-pro`, `gpt-4o-mini-tts`, `tts-1-hd`, `gpt-4o-transcribe`, `whisper-1` |
| **Google Gemini** (`gemini`) | image, video (Veo), TTS, music (Lyria), STT | `x-goog-api-key` | `POST /v1beta/models/{m}:generateContent` (Nano Banana, TTS, Lyria, transcription), `POST /v1beta/models/{m}:predictLongRunning` + `GET /v1beta/{operation}` (Veo), legacy `:predict` (Imagen) | `gemini-2.5-flash-image`, `gemini-3.1-flash-image`, `veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview`, `gemini-2.5-flash-preview-tts`, `lyria-3-clip-preview`, `gemini-2.5-flash` (STT) |
| **Stability AI** (`stability`) | image, music | `Bearer` | `POST /v2beta/stable-image/generate/{ultra,core,sd3}`, `POST /v2beta/audio/stable-audio-2/text-to-audio` (multipart, synchronous) | `stable-image-ultra`, `stable-image-core`, `sd3.5-large`, `sd3.5-large-turbo`, `stable-audio-2.5` |
| **ElevenLabs** (`elevenlabs`) | TTS (voice list), music, STT | `xi-api-key` | `POST /v1/text-to-speech/{voice_id}`, `GET /v2/voices`, `POST /v1/music`, `POST /v1/speech-to-text` | `eleven_multilingual_v2`, `eleven_v3`, `eleven_flash_v2_5`, `music_v1`, `scribe_v2` |
| **Runway** (`runway`) | image, video | `Bearer` + `X-Runway-Version` | `POST /v1/text_to_image`, `/v1/text_to_video`, `/v1/image_to_video`, `GET /v1/tasks/{id}` | `gen4_image`, `gen4.5`, `gen4_turbo` (image to video), `veo3.1` |
| **Luma Dream Machine** (`luma`) | image, video | `Bearer` | `POST /dream-machine/v1/generations` (+ `callback_url`), `POST …/generations/image`, `GET …/generations/{id}` | `ray-2`, `ray-flash-2`, `photon-1`, `photon-flash-1` |
| **Custom HTTP** (`custom_http`) | everything | from the connection | your template | anything – see below |

Base URLs come from the connection (an EU endpoint or a proxy works); the defaults are the official ones. An unknown preset id falls back to the HTTP template, so new presets keep working.

### Input mapping

The form fields (prompt, negative prompt, aspect ratio, duration, seed, voice, language, reference image/audio) are mapped to each provider's field names – e.g. `image_size: "landscape_16_9"` for FLUX on fal, `size: "1536x1024"` for OpenAI, `ratio: "1280:720"` for Runway, `aspectRatio` for Veo. Models differ a lot, so **Erweiterte Parameter (JSON)** is passed through unchanged and wins over the generated fields: with it you can use every option a model has (steps, guidance, LoRAs, camera control, `generate_audio`, resolution …).

### Pricing notes

HyperLevel shows the cost when the provider reports it (kie.ai credits, OpenAI image tokens, ElevenLabs characters, fal/Replicate compute seconds); Stability shows its list price as an estimate (≈). Typical orders of magnitude – always check the provider's current price list:

- **fal.ai** – per output (images roughly a few tenths of a cent to a few cents each, video per second); prepaid credit.
- **kie.ai** – credits per task (their docs: images typically 10–50 credits, videos 100–500).
- **Replicate** – official models per output, others per second of GPU time.
- **OpenAI** – images by quality/size (token based), TTS per character, transcription per minute, Sora per second of video.
- **Gemini** – Nano Banana per image, Veo per second of video, TTS per token; free tier for some models.
- **Stability AI** – credits ($0.01 each): Ultra 8, Core 3, SD 3.5 Large 6.5.
- **ElevenLabs** – characters from your plan; music per generation.
- **Runway / Luma** – credits per second of video or per generation.

## How a job runs

1. A request (KI-Studio, editor button, workflow, MCP, app) creates a job in `genmedia_jobs` (sub-account, user, provider, model, capability, input, status) and returns at once.
2. The job is submitted in the background. Synchronous APIs (OpenAI images/speech, Stability, ElevenLabs, Gemini `generateContent`) finish right there; asynchronous ones (fal queue, kie tasks, Replicate predictions, Gemini/Veo operations, OpenAI Sora, Runway, Luma) are **polled by the scheduler** with a growing interval.
3. If HyperLevel runs on a public `https://` address, providers that support it get a **per-job callback URL** (`/hooks/genmedia/<token>`, 24 random bytes, stored only as SHA-256). Signed callbacks are verified – fal.ai (ED25519 via its JWKS), Replicate (HMAC with the account's webhook secret), kie.ai (HMAC when the connection carries a `webhookSecret`). Unsigned callbacks (Luma, kie without secret, forged ones) are never trusted: they only make HyperLevel ask the provider right away.
4. Results are downloaded with an **SSRF guard** (no private, loopback, link-local or metadata addresses – checked on the literal and the resolved IP, again on every redirect; the provider key is only sent to the provider's own hosts), **size limits** (images 30 MB, audio 60 MB, video 200 MB) and a **type check from the bytes** (PNG, JPEG, WebP, GIF, MP4/MOV/WebM, MP3/WAV/OGG/FLAC/M4A – never HTML/SVG). Gemini's raw PCM speech becomes WAV.
5. Files are stored under `data/genmedia/` and served at `/genmedia/f/<random>.<ext>` (with byte ranges for video seeking). **In Mediathek** copies a result into the media library (`/uploads/…`); deleting a job keeps library copies. Uploaded inputs (reference images, recordings to transcribe) are removed after 30 days.
6. Transient errors (network, 429, 5xx) are retried up to 5 times with backoff – a submit only when the provider answered with 429/5xx, so a timeout never creates a second paid job. Jobs time out after 15 min (images, audio), 20 min (transcripts) or 45 min (video). At most 10 running jobs per sub-account.

When a job finishes, the event `genmedia.completed` (`{contactId?, jobId, capability, url, urls, text}`) fires – usable as workflow trigger **KI-Medium fertig** and for outgoing webhooks; `genmedia.failed` on errors.

## Using results everywhere

- **Gallery** (per tab): preview, provider cost, *Download*, *In Mediathek*, *Social-Post* (draft in the social planner – images via the regular route, videos as signed media link), *In E-Mail/Funnel* (adds to the library and copies the link), *Neu* (same settings), *Variation* (new seed), *edit* (load settings into the form), *Abbrechen*/*Löschen*.
- **KI-Bild generieren** in the e-mail builder's image picker, the funnel builder's image fields, the social composer and the blog/course/community image picker: prompt → image → it lands in the media library and in the field.
- **Video-Studio**: OpenShorts' AI shorts use their own fal.ai key; there is no b-roll input in its API yet, so generated videos are not wired into it (download or use the link instead).
- **Voice AI**: the phone agent speaks via Twilio `<Say>` voices; playing ElevenLabs/OpenAI audio per turn would need a `<Play>` flow with pre-generated audio and adds latency, so it is not wired in.

## Workflow actions

| Action | Fields | Result goes to |
| --- | --- | --- |
| **KI-Bild generieren** (`genmedia_image`) | connection (optional), model, prompt with merge fields, aspect ratio | custom field (link), note on the contact (with link), social post draft, or KI-Studio only |
| **KI-Video generieren** (`genmedia_video`) | + duration | same |
| **Text in Sprache** (`genmedia_tts`) | text with merge fields, voice | custom field or note |

The action starts the job and continues the workflow; the result arrives when the provider is done (always also in the media library). Chain follow-ups with the trigger **KI-Medium fertig** – e.g. send the contact an e-mail with `{{event.url}}`.

## MCP tools

Sub-account scoped (same rights, checks and audit log as the UI; the in-app agent and Claude/ChatGPT/Codex get them automatically):

- `ghl_generate_image` – prompt, model, aspect ratio, seed, reference `image_url`, raw `params`, `wait_seconds` (default 60)
- `ghl_generate_video` – prompt, duration, aspect ratio, start image; returns the `job_id` at once unless `wait_seconds` is set
- `ghl_generate_audio` – `kind: tts | music`, `text`, `voice`, `duration`
- `ghl_transcribe` – `audio_url` or `upload_id`, `language`
- `ghl_get_media_job` – status, file URLs (media library), text, cost, error

## Add any provider with an HTTP template

KI-Studio → **Eigene Anbieter** → *+ Vorlage*. Create a connection of type *Eigener Anbieter (HTTP)* in the BYOK settings for the key (auth style bearer / header / query) and optionally a base URL.

| Field | Meaning |
| --- | --- |
| Adresse | `https://…` or a path after the connection's base URL; `{{api_key}}` is allowed here and in headers (nowhere else) |
| Methode, Kopfzeilen | `POST`/`GET`/`PUT`, extra headers as JSON |
| JSON-Body | placeholders `{{prompt}}`, `{{negative_prompt}}`, `{{aspect_ratio}}`, `{{duration}}`, `{{seed}}`, `{{voice}}`, `{{language}}`, `{{model}}`, `{{image_url}}`, `{{audio_url}}`, `{{params.<field>}}`, `{{params}}`. Inside a string they are escaped; `"{{seed}}"` as a whole string keeps the JSON type (number, object, `null` when empty) |
| Ergebnis-Pfad | where the file is: `images[0].url`, `output`, `data[*].url`, `$.result.video` (a URL, a list of URLs or objects with `url`) – or **Base64** data. Speech to text: *Text-Pfad* |
| Asynchron | status URL with values from the first answer (`https://api.example.com/v1/tasks/{{response.id}}`), status path + "done" values, optional fail path/values and error path, interval |

Example – an async image API:

```json
{
  "url": "https://api.example.com/v1/generate",
  "method": "POST",
  "body": "{ \"model\": \"{{model}}\", \"input\": { \"prompt\": \"{{prompt}}\", \"aspect_ratio\": \"{{aspect_ratio}}\", \"seed\": \"{{seed}}\" } }",
  "result_path": "output[*]",
  "poll": { "url": "https://api.example.com/v1/tasks/{{response.id}}", "done_path": "status", "done_values": ["succeeded"], "fail_path": "status", "fail_values": ["failed"], "error_path": "error", "interval_s": 5 }
}
```

APIs that answer with the file itself (many TTS services) need no result path: a binary answer that is a valid media file is taken as is. Self-hosted services in your own network (ComfyUI, a local TTS) are blocked by the SSRF guard unless the server runs with `PGHL_ALLOW_PRIVATE_FETCH=1`.

## Security & rights

- Jobs, files, templates and inputs are scoped to the sub-account; other sub-accounts get 404. Stored file names are random (24 characters), like the media library.
- Client logins need one of the content areas *Social Planner*, *Funnels & Websites*, *Kampagnen & Vorlagen* or *Kurse*; the menu entry follows *Social Planner*. In SaaS mode the KI-Studio is closed when the plan leaves out all of these areas, and paused accounts are read-only. Posting to social channels additionally needs the social area.
- API keys of a sub-account and MCP OAuth tokens reach only their sub-account; device tokens (`ghm_…`) work on `/api/mobile/genmedia` only.
- Prompts and parameters are validated (length, JSON object ≤ 20 KB, aspect ratios, durations); reference files must be own uploads or public `https://` links; kie.ai task paths must be `/api/…` paths on the connection's host.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PGHL_GENMEDIA_MAX_IMAGE_MB` / `_VIDEO_MB` / `_AUDIO_MB` | 30 / 200 / 60 | largest result kept |
| `PGHL_GENMEDIA_TIMEOUT_MIN` | 15/20/45 by type | give up on a job after this many minutes |
| `PGHL_ALLOW_PRIVATE_FETCH` | off | allow private/LAN addresses (self-hosted generators) |

## API

See [docs/api.md → KI-Studio](api.md#ki-studio-media-generation) for the REST endpoints and [Mobile-App](api.md#mobile-app) for `POST /api/mobile/genmedia`.

## To verify with real keys

The adapters follow the providers' public docs (October 2026) and are tested against recorded-shape fakes, not live accounts. Worth checking with real keys: fal input field names per model (`image_size` vs `aspect_ratio`, duration formats), kie.ai market model ids and Suno/Midjourney legacy endpoints, Gemini `imageConfig` and Veo `durationSeconds` types, OpenAI `images/edits` JSON with data URLs, Stability multipart field names, ElevenLabs cost header name, Replicate file URLs that need the token, and the fal/Replicate webhook signatures.
