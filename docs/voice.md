# Voice (Stimme): bring your own speech providers

**Settings → Stimme** puts one voice layer on top of the [AI providers (BYOK)](ai-providers.md): text to speech (TTS) and speech to text (STT) with your own keys, used by

- the **AI phone agent** (KI-Telefonagent) – answers calls with *your* voice instead of Twilio's, live or in recorded turns,
- the **HyperLevel Agent** – a microphone button (push-to-talk) and spoken replies,
- **voicemails** – transcribed (and summarised) with your speech recognition,
- the **KI-Studio**, the workflow action *Text in Sprache* and the MCP tools – they use the same adapters, so every provider below works there too.

Nothing changes until you pick a provider: without one, the phone agent keeps using Twilio's voices and the Agent panel keeps the browser's own speech input.

Keys are sealed in the registry and never shown again; costs run on your account with the provider. HyperLevel only counts what it asked for (characters spoken, recordings, phone minutes) on the settings page.

## Providers

| Provider | Preset | Text to speech | Speech to text | Live on the phone |
| --- | --- | --- | --- | --- |
| OpenAI | `openai` | gpt-4o-mini-tts (with a style instruction), tts-1 | gpt-4o-transcribe, gpt-4o-mini-transcribe, whisper-1 | TTS: yes (PCM 24 kHz → µ-law here) · STT: per sentence |
| ElevenLabs | `elevenlabs` | Multilingual v2, Flash v2.5, own and cloned voices, live voice list | Scribe | TTS: yes (µ-law directly, HTTP stream or WebSocket) · STT: per sentence |
| Deepgram | `deepgram` | Aura 2 (the voice is the model: `aura-2-viktoria-de`, …) | Nova 3 / Nova 2 | TTS: yes · STT: **live** (WebSocket, µ-law) – the fastest choice for calls. EU address: `https://api.eu.deepgram.com` |
| Cartesia | `cartesia` | Sonic 2, Sonic Turbo, Sonic 3 (needs a voice id) | Ink Whisper | TTS: yes (µ-law directly) · STT: per sentence |
| AssemblyAI | `assemblyai` | – | Universal (language detection, word boost) | STT: **live** (streaming v3 with a short-lived token). EU address: `https://api.eu.assemblyai.com` |
| Azure Speech | `azure_speech` | Neural voices (`de-DE-KatjaNeural`, SSML), live voice list | Fast transcription | TTS: yes (µ-law directly) · STT: per sentence. Address from the Azure portal, e.g. `https://germanywestcentral.api.cognitive.microsoft.com` |
| Google Cloud Speech | `google_speech` | Text-to-Speech (Neural2, WaveNet …), voice list per language | Speech-to-Text (latest_long / latest_short) | TTS: yes (MULAW) · STT: per sentence. Enable both Cloud APIs for the key |
| Google Gemini | `gemini` | gemini-2.5-flash-preview-tts (30 voices) | via generateContent | TTS: yes (WAV converted here) · STT: per sentence |
| Local server | `speech_local` | Kokoro-FastAPI, openedai-speech (Piper), LocalAI … (`/v1/audio/speech`) | Speaches / faster-whisper-server, whisper.cpp … (`/v1/audio/transcriptions`) | TTS: yes · STT: per sentence. No key needed; a local address needs an agency admin's "Lokales Netz erlauben" |
| Groq, Mistral, Azure OpenAI, LiteLLM | existing presets | OpenAI wire format | Whisper / Voxtral | per sentence |
| Custom (HTTP) | `custom_http` | via a request template | – | recorded turns only |

"**Live**" providers can stream into a call. Everything else is cut into sentences by a voice activity detector and sent to the provider's normal file API – a little slower, but it works with every provider. In the connection form, cards of live providers carry a green *Live* badge.

**Voices.** *Stimmen laden* asks the provider for its list (ElevenLabs, Cartesia, Azure, Google; Deepgram, OpenAI and Gemini have built-in lists, Kokoro lists its own). You can always type any voice id, for example a cloned voice. The list can be filtered by language.

## Set up

1. **Settings → KI-Anbieter:** add the provider(s) and tick the capabilities *Sprachausgabe* and/or *Transkription*. Under *Wofür welches Modell?* the usages *Sprachausgabe (TTS)* and *Transkription* choose the default connection per sub-account or for the whole agency.
2. **Settings → Stimme:** choose provider, voice, language, speed; press **Abspielen** (*Stimme testen*) and **Mikrofon testen**.
3. For the phone agent: set *Stimme und Zuhören am Telefon* to **Eigener Anbieter**. Twilio and the AI phone agent are set up as before ([self-hosting](self-hosting.md#ai-phone-agent)); nothing changes in Twilio's console.

| Setting | Meaning |
| --- | --- |
| Sprachausgabe: Anbieter, Modell, Stimme, Sprache, Tempo, Stil-Anweisung | Defaults for the Agent, the test and the phone. Speed is passed on where the provider supports it (OpenAI tts-1, ElevenLabs, Cartesia Sonic 3, Azure, Google); *Stil-Anweisung* is OpenAI gpt-4o-mini-tts only |
| Spracherkennung: Anbieter, Modell, Sprache | Defaults for push-to-talk, voicemail and the phone |
| Telefon: Engine | *Twilio (Standard)* or *Eigener Anbieter* |
| Telefon: Übertragung | *Automatisch* (live stream when the TTS provider can and the server has a public https address, otherwise recorded turns), *Live-Stream*, *Aufnahme-Runden* |
| Telefon: eigene Anbieter, Stimme, Modelle | Optional – a different voice or provider on the phone than elsewhere |
| Pause bis zur Antwort | 300–2500 ms of silence that end the caller's turn |
| Unterbrechen erlauben | Barge-in on/off |
| „Einen Moment bitte“ | Say it once when the agent needs longer than 3 seconds |
| ElevenLabs über WebSocket | `stream-input` instead of the HTTP stream |
| HyperLevel Agent: Vorlesen / sofort senden | Sub-account defaults; every person can override them in the Agent panel |
| Voicemails transkribieren / Zusammenfassung | After a voicemail is stored |

## The phone agent with its own voice

The agent's brain is unchanged ([modules/voice-ai.ts](../server/modules/voice-ai.ts): prompt, knowledge, booking, messages, transfer, summary, limits, the monthly AI budget). The voice layer only decides **how it is heard and spoken**:

```
caller ──µ-law 8 kHz──▶ Twilio ──wss──▶ HyperLevel ──▶ live STT ──text──▶ agent (LLM + tools) ──text──▶ TTS ──µ-law──▶ Twilio ──▶ caller
                                            ▲                                                       │
                                            └──────── barge-in: caller speaks → `clear`, TTS aborted ┘
```

**Live stream (Twilio Media Streams).** The answer to an incoming call is `<Connect><Stream>`; Twilio opens a WebSocket to `wss://<your-address>/hooks/twilio/stream/<sub-account>` and sends 20 ms µ-law frames as JSON (`start`, `media`, `mark`, `stop`). HyperLevel feeds them to live STT, speaks the agent's answer as soon as the TTS's first bytes arrive (sent in 20 ms multiples; a `mark` tells when Twilio played everything) and answers `clear` when the caller breaks in. The server speaks WebSocket itself (RFC 6455, no npm package): `server/services/voice-ws.ts`; the µ-law/PCM/WAV/resampling/VAD toolkit is `server/services/voice-audio.ts`.

- **Barge-in:** our own voice activity detection on the caller's audio (independent of the STT provider; ≥ 250 ms of speech) or a recognised word while the agent talks → Twilio's buffer is cleared, the TTS request is cancelled, the caller's turn is taken. Speech in the first 300 ms of an answer is ignored (trailing words of the caller). Switch it off in the settings if a line echoes.
- **Latency** is measured per turn – caller stopped talking → STT text (*Erkennen*), text → answer (*KI*), answer → first audio (*Stimme*), and the total the caller feels – and shown on the settings page (median, 95 %). Use the numbers to compare providers – live STT and a streaming TTS with a low-latency model (Deepgram, ElevenLabs Flash, Cartesia Turbo) are the usual levers. The greeting and "Einen Moment bitte" are kept in memory, so they start without a provider round trip.
- **Fallback:** whenever the own voice fails – STT cannot connect (a dropped recogniser is reconnected twice first), the TTS errors, the agent does not answer, the stream breaks – HyperLevel closes the stream and the call carries on with **Twilio's voices** (`<Gather>` + `<Say>`, the classic loop). The line that was meant to be said is spoken by Twilio instead; the call never goes silent. The reason is written to the call's actions (*Eigene Stimme ausgefallen …*). A greeting that is already cached (for up to an hour) is played even if the provider is down.
- **Hang-up, transfer, voicemail:** after the goodbye was played (the `mark`), the stream ends and Twilio's `action` URL (`/hooks/twilio/voice-ai-stream-end/<sub-account>`) is asked what to do next; it answers `<Hangup/>`, the `<Dial>` of the transfer or the voicemail recorder.

**Recorded turns.** `<Record>` (ends after 2 s of silence, max 30 s, no beep) → HyperLevel fetches the recording from Twilio with your account's credentials (only recordings of *your* Twilio account, only from `api.twilio.com`), deletes it at Twilio, transcribes it, asks the agent and plays the answer with `<Play>` (a short-lived, unguessable link, kept in memory for 10 minutes). Slower (a second or two per turn more) and the caller cannot interrupt, but it works with **every** TTS provider (mp3) and without WebSocket support on your proxy. If the agent needs more than ~9 s, Twilio's voice says *Einen Moment bitte* and Twilio asks again.

**Requirements for the live stream**

- A public `https://` base address (*Agency → Basis-Adresse*). The settings page tells you when it is missing; *Automatisch* then uses recorded turns.
- Your reverse proxy must pass WebSocket upgrades on `/hooks/twilio/stream/…`. Caddy does it by default; nginx needs `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`.
- A TTS provider that can answer in µ-law (ElevenLabs, Cartesia, Deepgram, Azure, Google), in PCM (OpenAI, local servers) or in WAV (Gemini, Groq, Mistral, Azure OpenAI). Providers that only deliver mp3 use recorded turns.

**Security.** The TwiML carries a token (HMAC of sub-account, call and expiry, 10 minutes) that Twilio hands back in the stream's `start` message; without a valid token – or when the call has no running agent session, or the account SID differs – the socket is closed (code 1008) before any audio flows. At most 15 streams per sub-account and 80 per server; frames are limited to 64 KB. Webhooks of the turn flow are checked with Twilio's signature like all other Twilio webhooks.

## HyperLevel Agent: push-to-talk and spoken replies
## Outbound AI calls

The phone agent can also **call contacts itself** – with the workflow action **„KI-Anruf starten (Voice AI)“** (`voice_ai_call`), from *Einstellungen → Telefonie → Ausgehende KI-Anrufe* (*KI-Anruf starten*) or over the API/MCP.

| Setting of the step | |
| --- | --- |
| Ziel | **Qualifizieren** (need, time frame, budget, decision maker – noted as a message or opportunity), **Termin vereinbaren** (free times and booking as for inbound calls) or **Termin-Erinnerung** (the contact's next appointment is in the prompt; a new time can be booked) |
| Leitfaden / Prompt | What the agent should ask, offer or avoid (merge fields allowed). It goes into the agent's prompt next to the goal; the persona, knowledge, tools and limits of the KI-Telefonagent apply |
| Erster Satz | Optional opening line; the default per goal says honestly that a KI-Assistent is calling |
| Mailbox-Nachricht | Spoken when an answering machine picks up (otherwise hang up) |
| Absendernummer | A Twilio number or a [verified own number](telephony.md#your-own-number-as-caller-id); empty = the default |

**The gate – checked on the server before anything is dialled:** the power dialer's verdict (number, *Nicht stören*, channel do-not-disturb, consent, calling days and hours, public holidays of the chosen state – [telephony.md](telephony.md#power-dialer)) and a **daily limit** per sub-account (default 50, *Höchstens Anrufe pro Tag*). An AI call is an **automated call** under § 7 Abs. 2 UWG: for *Qualifizieren* and *Termin vereinbaren* only a **confirmed phone consent** in the ledger counts, whatever the dialer's consent rule says; a *Termin-Erinnerung* about a booked appointment is a service call and follows the sub-account's rule. A contact who may not be called is not called – the step says why („Nicht angerufen: …“), the contact's timeline too. At most one AI call per contact runs at a time.

**The call:** Twilio places it with **answering machine detection** (`MachineDetection`; `DetectMessageEnd` when there is a mailbox message, so it is spoken after the beep). A **person** gets the agent – over `<Connect><Stream>` with your own voice and speech recognition when *Stimme und Zuhören am Telefon* is set to *Eigener Anbieter* (the live pipeline above), otherwise with Twilio's voices. The agent knows it placed the call (“DU rufst an”) and that someone who does not want calls gets an apology and the end of the call.

**Results** – one per call, each a workflow trigger: *KI-Anruf: angenommen* (`voice_ai_call.answered`), *KI-Anruf: Termin gebucht* (`voice_ai_call.booked`), *KI-Anruf: nicht erreicht* (`voice_ai_call.no_answer` – no answer, busy, rejected, failed) and *KI-Anruf: Mailbox* (`voice_ai_call.voicemail`), with `{{event.goal}}`, `{{event.summary}}`, `{{event.outcome}}`, `{{event.appointmentId}}`. As for inbound AI calls, the **transcript and the summary** go to the contact as a note and a timeline entry, the call appears in the call log and the inbox; *KI-Anruf beendet* (`voice_ai.completed`) fires too.

API (area *Konversationen*; the settings *Einstellungen*): `POST /api/voice-ai/outbound` `{contact_id, goal, script?, greeting?, voicemail_text?, from?}` → `{id, status: ringing|blocked, reason?}`, `GET /api/voice-ai/outbound` (latest calls, settings, counts of today and the last 30 days), `PUT /api/voice-ai/outbound/settings` `{daily_limit, caller_id, voicemail_text}`. Twilio webhooks (signed): `/hooks/twilio/voice-ai-out/<sub-account>`, `/hooks/twilio/voice-ai-out-status/<sub-account>`. MCP: `ghl_voice_ai_call` (calls for real – the same gate applies).

## HyperLevel Agent: push-to-talk and spoken replies

The microphone button in the Agent panel:

1. **Tap** to start, tap again to stop – or **hold** and release (touch screens too). Esc cancels.
2. The recording (MediaRecorder: WebM/Opus, MP4 in Safari; up to 90 s) goes to `POST /api/voice/transcribe` and comes back as text in the message box – editable. With *sofort senden* (per person or sub-account default) it is sent as it is.
3. **Voice never confirms anything.** Changes still wait for the confirmation card; nothing in the voice path can approve an action.
4. The speaker button reads the agent's answers aloud with your voice (code, links and markup are skipped, the first ~700 characters are read).

Google Cloud Speech derives the voice's `languageCode` from its name (`en-GB-Neural2-B` → `en-GB`, `cmn-CN-…` → `cmn-CN`); only a voice without a locale prefix uses the language setting.

The **Fokus-Modus mit Companion** uses the same speech to text and voice – Jarvis by default with a native Google Chirp 3 HD voice in the app's language – `de-DE-Chirp3-HD-Iapetus` / `en-US-Chirp3-HD-Iapetus`, no accent ([living-boards.md](living-boards.md#the-companions-voice)): its microphone (tap = hands-free, it ends when you pause; hold = push to talk), the edge button and Alt+J on every page, an optional wake word with the browser's own recognition, and one voice for every answer with barge-in – see [living-boards.md](living-boards.md#fokus-modus-mit-companion). Since 1.0.54 it holds a conversation ([Jarvis live](living-boards.md#jarvis-live)): a follow-up window with voice-activity detection in the browser, barge-in on the open microphone, answers spoken sentence by sentence while the agent writes, and – optionally – the realtime voice through the **Gemini Live API** (a *Google Gemini* connection; the server relays the audio over a WebSocket, the key stays on the server).

Without a speech recognition connection the panel falls back to the browser's Web Speech API (where it exists), as before. In the **Android app** (a WebView) the microphone permission and autoplay are already handled for the browser phone; the web app only needs https. Limits: 15 MB per recording (a few minutes), 40 recordings / 40 spoken replies / 15 tests per person per minute.

## Voicemail and summaries

With *Voicemails transcribieren*, a stored voicemail is fetched from Twilio, transcribed with your STT connection and written to the call (and thereby the inbox and the contact timeline). *Zusammenfassung* adds two lines – who, what, next step – written by the AI assistant (counts towards its monthly limit). Turn off Twilio's own transcription (Settings → Telefonie) to avoid two transcripts.

## API

All under the sub-account (login with `x-location-id`, sub-account API key or agency key). Settings, voices, test and latency need the area *Einstellungen*; push-to-talk, spoken replies and the own preferences need no extra area.

| Endpoint | |
| --- | --- |
| `GET/PUT /api/voice/settings` | `{settings: {tts: {connection_id, model, voice, language, speed, instructions}, stt: {connection_id, model, language}, phone: {engine: twilio\|own, transport: auto\|stream\|turns, tts_connection_id, tts_model, tts_voice, stt_connection_id, stt_model, tts_ws, endpoint_ms, barge_in, filler}, agent: {read_aloud, auto_send}, voicemail_transcribe, call_summary}, connections, routed, phone: {plan, twilio_ready, agent_ready, public_https}, usage, latency, limits}` – PUT takes a partial patch |
| `GET /api/voice/voices?connection_id=&language=&refresh=1` | `{voices: [{id, name, lang?, gender?, preview?}], connection, free_text: true}` |
| `POST /api/voice/test` | `{text?, voice?, model?, connection_id?, language?, speed?, instructions?}` → `{audio: "data:audio/mpeg;base64,…", provider, model, voice, chars, bytes, ms}` |
| `POST /api/voice/transcribe?language=&vocabulary=` | the raw recording as body (WebM, Ogg, MP3, WAV, M4A, FLAC; type decided from the bytes) or JSON `{data: "data:audio/…;base64,…"}` → `{text, provider, model, ms, bytes}` |
| `POST /api/voice/transcribe-url` | `{upload_id}` (media library) or `{url}` (public https, max 15 MB), `language?`, `vocabulary?` → same |
| `POST /api/voice/speak[?format=json]` | `{text, voice?, provider?, connection_id?}` (text max 4000 characters) → the audio file, or `{audio: data-URL, mime}`. Without `provider`/`connection_id` the person's preferred voice (else the sub-account's). With them – the companion's voice, e.g. `{provider: "google_speech", voice: "de-DE-Chirp3-HD-Iapetus"}` (`voice: "auto"` + `lang: "de"|"en"` = the Jarvis voice of the provider in that language: Google's native voice, on kie.ai *Brian* with `language_code`, other providers their default; `lang` is also passed on as the language of the text) – only an audio_tts connection of this sub-account: `connection_id` must be one (else `404`), `provider` (a preset id) takes its first connection with a key (none: `409`); `voice` max 120 characters of letters, digits and ` _.:'()/@+-`. The sub-account's saved voice/model are only used for its own voice connection. Same per-person limit and usage count as before |
| `GET/PUT /api/voice/prefs` | `{prefs: {read_aloud, auto_send, voice, connection_id}, effective, defaults, ready: {stt, tts}, connections: [{id, label, provider, usable}]}` – `null` = use the sub-account default; `connections` = the sub-account's connections that can speak (no keys) |
| `GET /api/voice/latency?limit=` | `{summary: {turns, interrupted, total_p50, total_p95, stt_avg, llm_avg, tts_avg}, turns: [...]}` |
| Twilio (public) | `/hooks/twilio/stream/<sub-account>` (WebSocket), `POST /hooks/twilio/voice-ai-stream-end/…`, `…/voice-ai-turn/…`, `…/voice-ai-turn-wait/…` (signed), `GET /hooks/voice/play/<token>.<ext>` |
| Native app | `POST /api/mobile/voice/transcribe` `{location_id, data: "data:audio/…;base64,…", language?}`, `POST /api/mobile/voice/speak` `{location_id, text}` → `{audio, mime}` (device token `ghm_…`) |

**MCP tools** (usable by the HyperLevel Agent, Claude and Codex): `ghl_voice_get_settings`, `ghl_voice_update_settings`, `ghl_voice_list_voices`, `ghl_voice_test_voice` (no audio is returned), `ghl_voice_transcribe` (`upload_id` or `url`), `ghl_voice_phone_latency`. All writes appear in the audit log.

## For developers

| File | What |
| --- | --- |
| `server/services/voice-adapters.ts` | KI-Studio adapters for Deepgram, Cartesia, AssemblyAI, Azure Speech, Google Cloud Speech and OpenAI-compatible servers (registered with `registerAdapter` from `genmedia/index.ts`) |
| `server/services/voice-stream-tts.ts`, `voice-stream-stt.ts` | streaming TTS (µ-law chunks, abortable) and live STT openers per provider; `BatchLiveStt` cuts any provider into utterances |
| `server/services/voice-engine.ts` | `synthesize`, `transcribe`, `listVoices`, `liveTts`, `openLiveStt`, `phonePlan` over the BYOK registry |
| `server/services/voice-phone.ts` | the Media Stream session (protocol, turn loop, barge-in, fallbacks) – pure, driven by a fake socket in tests |
| `server/services/voice-twiml.ts` | `<Connect><Stream>`, `<Record>`/`<Play>`, stream tokens, short-lived audio store |
| `server/services/voice-ws.ts`, `voice-audio.ts` | WebSocket server endpoint (`app.services.upgradeHandlers`), G.711/PCM/WAV/resampling/VAD |
| `server/modules/voice.ts`, `voice-tools.ts` | settings, voices, test, push-to-talk, prefs, mobile relay, MCP tools |
| `server/modules/voice-phone.ts` | Twilio hooks, the stream endpoint, recorded turns, voicemail transcription |
| `server/modules/voice-outbound.ts` | outbound AI calls: workflow action `voice_ai_call`, the gate (dialer verdict + daily limit), Twilio call with AMD, the four result triggers; goal and script reach the agent through `app.services.voicePromptExtras` |
| `web/src/pages/Voice.tsx`, `web/src/agent/voice.ts` | the settings page; recorder, transcription and playback helpers |

Hooks: `app.services.voicePromptExtras` (list of `(session) => text | undefined` – extra prompt context per call), `VoiceAgentInput.stage: 'outbound'` with `greeting` and `party`, `app.services.voiceOutbound.start(loc, input)`, `app.services.voiceBrain` (set by `voice-ai.ts`: `open`, `turn`, `silence`, `degrade`, `note`), `voiceTransport` (set by `voice-phone.ts`, read by `voice-ai.ts` when it takes a call), `upgradeHandlers` (HTTP upgrades), `voiceTurnLog`. Test hooks: `voiceFetch` (streaming provider calls), `voiceWs` (WebSocket factory), `genmediaFetch` (one-shot calls), `twilioFetch`. A new provider is one adapter (`registerAdapter`), optionally a streamer in `TTS_STREAMERS` / an opener in `STT_OPENERS`, and a preset in `ai-presets.ts` (with the `realtime` flag).

Providers' endpoints follow their public documentation (October 2026) and are tested against fakes, never against live accounts.

## Checked with fakes only – please verify with real accounts

Everything above is covered by tests with fake providers, a fake Twilio and a real WebSocket client against the test server (`tests/voice-*.test.ts`). These points need a real call once:

1. **Outbound calls:** answering machine detection results (`AnsweredBy`) of your Twilio account and the timing of `DetectMessageEnd`.
1. **Twilio Media Streams** with your account: `<Connect action>` after the stream ends (the code asks `voice-ai-stream-end`), the `mark` echo timing and the audio quality of µ-law from your TTS provider.
2. **Each provider's live endpoints**: Deepgram `listen` (WebSocket with the `token` sub-protocol), AssemblyAI streaming v3 (token endpoint), ElevenLabs `stream-input`.
3. **Recorded turns** need Twilio's recording URL to be fetchable right after the `<Record>` action (HyperLevel retries on 404).
4. **Proxy:** WebSocket upgrades through your reverse proxy.
5. **Jarvis's voice:** a kie.ai connection (ElevenLabs Turbo 2.5, voice *Brian*, told the app's language – [living-boards.md](living-boards.md#the-companions-voice)) or Google Cloud Text-to-Speech `de-DE-Chirp3-HD-Iapetus` (German UI) / `en-US-Chirp3-HD-Iapetus` (English UI) with your own key (Text-to-Speech API enabled) and the browser fallback (a natural male voice of the language, e.g. *Microsoft Conrad Online (Natural)* in Edge) in focus mode.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Settings page: "Twilio erreicht den Server nur über eine öffentliche https-Adresse" | Set the base address under *Agency*; use *Aufnahme-Runden* meanwhile |
| Call starts with Twilio's voice although *Eigener Anbieter* is on | The call's actions say why (*Twilio-Stimme statt eigener Stimme*): missing STT/TTS connection or no key |
| Greeting is spoken by Twilio, then the call goes on | The provider failed (quota, key, network): *Eigene Stimme ausgefallen …* in the call's actions |
| The agent cuts itself off | Echo on the caller's line – switch *Unterbrechen erlauben* off or raise the pause |
| *Mikrofon testen* says the browser may not use the microphone | Allow the microphone in the site settings (needs https or localhost) |
| 409 "Für die Sprachausgabe fehlt ein Anbieter" | No connection with the capability *Sprachausgabe* – add one under KI-Anbieter |
