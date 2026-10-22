import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { MODELS as CLAUDE_MODELS, PRICES as CLAUDE_PRICES, API_VERSION as ANTHROPIC_VERSION } from './anthropic.js';
import { isPrivateIp } from './net.js';
import { livePrice, type ModelInfoKind } from './ai-model-info.js';
import { EXTRA_PRESETS } from './ai-presets-extra.js';

/**
 * KI-Anbieter (BYOK): presets for every provider people bring their own key for – text models
 * (OpenAI, Anthropic, Gemini, OpenRouter, Groq, Together, Fireworks, DeepSeek, Mistral, xAI,
 * Perplexity, Cerebras, Hugging Face, Azure, Ollama, LM Studio, vLLM/LiteLLM, any OpenAI-compatible
 * server) and media (fal.ai, kie.ai, Replicate, Stability, ElevenLabs, Runway, Luma, custom HTTP).
 * Pure data plus helpers: auth headers per style, chat endpoints, model-list parsing, prices, and a
 * fetch for user-supplied URLs that refuses private networks unless an agency admin allowed it.
 *
 * Wire formats for chat: `anthropic` (Messages API) and `openai` (Chat Completions – which almost
 * every text provider speaks). Media presets (`http`) only store key + base URL; generation
 * adapters live in their own modules and read them via `app.services.aiConnections.resolve`.
 */

export type Capability = 'text' | 'vision' | 'image' | 'video' | 'audio_tts' | 'audio_music' | 'stt' | 'embeddings';
export const CAPABILITIES: Capability[] = ['text', 'vision', 'image', 'video', 'audio_tts', 'audio_music', 'stt', 'embeddings'];
export const CAPABILITY_LABELS: Record<Capability, string> = {
  text: 'Text',
  vision: 'Bilder verstehen',
  image: 'Bilder erzeugen',
  video: 'Video',
  audio_tts: 'Sprachausgabe',
  audio_music: 'Musik',
  stt: 'Transkription',
  embeddings: 'Embeddings',
};
export const isCapability = (v: unknown): v is Capability => typeof v === 'string' && (CAPABILITIES as string[]).includes(v);

/** What a connection is used for (routing) and which capability that needs. */
export const USAGES = {
  agent: { label: 'KI-Agent (Chat & Werkzeuge)', cap: 'text' },
  text: { label: 'Schnelle KI-Texte (KI-Assistent, Workflows, Telefon …)', cap: 'text' },
  summary: { label: 'Zusammenfassungen', cap: 'text' },
  workflows: { label: 'KI-Workflow-Builder (Workflows entwerfen und ändern)', cap: 'text' },
  sites: { label: 'Funnel & Website AI (Seiten, Funnels, Blog- und E-Mail-Texte)', cap: 'text' },
  werkstatt: { label: 'Werkstatt: Mini-Apps bauen, Änderungen, Kernfeature-Spezifikation (Spitzenmodell)', cap: 'text' },
  werkstatt_review: { label: 'Werkstatt: Zweitmeinung bei der Prüfung (ein anderes Spitzenmodell)', cap: 'text' },
  embeddings: { label: 'Embeddings (Suche)', cap: 'embeddings' },
  image: { label: 'Bilder erzeugen', cap: 'image' },
  video: { label: 'Videos erzeugen', cap: 'video' },
  audio_tts: { label: 'Sprachausgabe (TTS)', cap: 'audio_tts' },
  audio_music: { label: 'Musik', cap: 'audio_music' },
  stt: { label: 'Transkription', cap: 'stt' },
} as const satisfies Record<string, { label: string; cap: Capability }>;
export type UsageKey = keyof typeof USAGES;
export const USAGE_KEYS = Object.keys(USAGES) as UsageKey[];
export const isUsage = (v: unknown): v is UsageKey => typeof v === 'string' && v in USAGES;
/** The capability a routing key or capability name needs. */
export const capOf = (key: string): Capability | null => (isUsage(key) ? USAGES[key].cap : isCapability(key) ? key : null);

/** Stored auth style; "header" and "query" take their name from `auth_header` (query: media/HTTP connections only). */
export type AuthStyle = 'bearer' | 'x-api-key' | 'key' | 'token' | 'header' | 'query' | 'none';
export const AUTH_STYLES: AuthStyle[] = ['bearer', 'x-api-key', 'key', 'token', 'header', 'query', 'none'];
/** `responses` = OpenAI's Responses API – only used by the personal ChatGPT sign-in (modules/ai-subscriptions.ts), never by a stored preset. */
export type Wire = 'openai' | 'anthropic' | 'responses' | 'http';
/** Gallery filter tags (derived: `eu` from `eu`, `local` from `local`). */
export type PresetTag = 'cheap' | 'fast' | 'gateway';

export interface Preset {
  id: string;
  label: string;
  group: 'text' | 'local' | 'media' | 'voice' | 'custom';
  wire: Wire;
  /** Default base URL (empty: the user enters one). */
  baseUrl: string;
  /** The user enters or may change the base URL (then it is guarded). */
  customUrl: boolean;
  auth: AuthStyle;
  /** Header name for auth style "header" (e.g. api-key, xi-api-key). */
  authHeader?: string;
  /** Fixed headers every call needs (API versions). */
  headers?: Record<string, string>;
  keyRequired: boolean;
  keyHint: string;
  capabilities: Capability[];
  /** Suggestions per capability (free text is always allowed); first = default. */
  models: Partial<Record<Capability, string[]>>;
  /** How the live model list is read. */
  listModels: 'openai' | 'anthropic' | 'none';
  /** USD per million tokens (input, output) for text – an estimate, editable per connection. */
  price: { input: number; output: number };
  /** Where to create a key. */
  keyUrl: string;
  docs: string;
  note?: string;
  local?: boolean;
  /** Live (streaming) voice: the phone agent can stream audio to/from this provider (services/voice-*.ts). */
  realtime?: { audio_tts?: boolean; stt?: boolean };
  /** Where the provider processes data, as its own documentation says – only set where it does (badge and filter "EU-Hosting"). */
  eu?: { region: string; source: string; note?: string };
  /** Gallery filters: günstig, schnell, Gateway. */
  tags?: PresetTag[];
  /** Shape of the provider's model list (prices, context, vision): services/ai-model-info.ts. */
  infoKind?: ModelInfoKind;
  /** Id in the partner-link catalogue (modules/referrals.ts) when it differs from the preset id. */
  referral?: string;
  /** Month the settings were checked against the provider's documentation. */
  verified?: string;
}

const P = (p: Preset) => p;

export const PRESETS: Preset[] = [
  P({ id: 'openai', label: 'OpenAI', group: 'text', wire: 'openai', baseUrl: 'https://api.openai.com/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'sk-…', capabilities: ['text', 'vision', 'image', 'audio_tts', 'stt', 'embeddings'], models: { text: ['gpt-5-mini', 'gpt-5.1', 'gpt-5-nano', 'gpt-4.1-mini'], vision: ['gpt-5-mini'], image: ['gpt-image-1'], audio_tts: ['gpt-4o-mini-tts', 'tts-1'], stt: ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1'], embeddings: ['text-embedding-3-small', 'text-embedding-3-large'] }, listModels: 'openai', price: { input: 1.25, output: 10 }, keyUrl: 'https://platform.openai.com/api-keys', docs: 'https://platform.openai.com/docs', realtime: { audio_tts: true } }),
  P({ id: 'anthropic', label: 'Anthropic (Claude)', group: 'text', wire: 'anthropic', baseUrl: 'https://api.anthropic.com', customUrl: false, auth: 'x-api-key', headers: { 'anthropic-version': ANTHROPIC_VERSION }, keyRequired: true, keyHint: 'sk-ant-…', capabilities: ['text', 'vision'], models: { text: CLAUDE_MODELS.map((m) => m.id) }, listModels: 'anthropic', price: { input: 2, output: 10 }, keyUrl: 'https://console.anthropic.com/settings/keys', docs: 'https://docs.anthropic.com' }),
  P({ id: 'gemini', label: 'Google Gemini', group: 'text', wire: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'AIza…', capabilities: ['text', 'vision', 'image', 'embeddings', 'audio_tts', 'stt'], models: { text: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'], image: ['imagen-4.0-generate-001'], embeddings: ['gemini-embedding-001'], audio_tts: ['gemini-2.5-flash-preview-tts'], stt: ['gemini-2.5-flash'] }, listModels: 'openai', price: { input: 1.25, output: 10 }, keyUrl: 'https://aistudio.google.com/apikey', docs: 'https://ai.google.dev/gemini-api/docs/openai' }),
  P({ id: 'openrouter', label: 'OpenRouter', group: 'text', wire: 'openai', baseUrl: 'https://openrouter.ai/api/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'sk-or-…', capabilities: ['text', 'vision', 'image'], models: { text: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5-mini', 'google/gemini-2.5-flash', 'meta-llama/llama-3.3-70b-instruct', 'deepseek/deepseek-chat'] }, listModels: 'openai', infoKind: 'openrouter', tags: ['gateway'], price: { input: 3, output: 15 }, keyUrl: 'https://openrouter.ai/settings/keys', docs: 'https://openrouter.ai/docs', verified: '2026-10', note: 'Ein Schlüssel für über 400 Modelle; die Liste zeigt Preise je Modell. HyperLevel meldet sich bei OpenRouter mit HTTP-Referer und X-OpenRouter-Title als App an (App-Zuordnung, keine Nutzerdaten).' }),
  P({ id: 'groq', label: 'Groq', group: 'text', wire: 'openai', baseUrl: 'https://api.groq.com/openai/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'gsk_…', capabilities: ['text', 'stt'], models: { text: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'qwen/qwen3-32b'], stt: ['whisper-large-v3-turbo'] }, listModels: 'openai', price: { input: 0.6, output: 0.8 }, keyUrl: 'https://console.groq.com/keys', docs: 'https://console.groq.com/docs/openai' }),
  P({ id: 'together', label: 'Together AI', group: 'text', wire: 'openai', baseUrl: 'https://api.together.xyz/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'API-Schlüssel', capabilities: ['text', 'vision', 'image', 'embeddings'], models: { text: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo', 'deepseek-ai/DeepSeek-V3'], image: ['black-forest-labs/FLUX.1-schnell'] }, listModels: 'openai', price: { input: 0.9, output: 0.9 }, keyUrl: 'https://api.together.ai/settings/api-keys', docs: 'https://docs.together.ai/docs/openai-api-compatibility' }),
  P({ id: 'fireworks', label: 'Fireworks AI', group: 'text', wire: 'openai', baseUrl: 'https://api.fireworks.ai/inference/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'fw_…', capabilities: ['text', 'vision', 'image', 'embeddings'], models: { text: ['accounts/fireworks/models/llama-v3p3-70b-instruct', 'accounts/fireworks/models/deepseek-v3', 'accounts/fireworks/models/qwen3-235b-a22b'] }, listModels: 'openai', price: { input: 0.9, output: 0.9 }, keyUrl: 'https://fireworks.ai/account/api-keys', docs: 'https://docs.fireworks.ai/tools-sdks/openai-compatibility' }),
  P({ id: 'deepseek', label: 'DeepSeek', group: 'text', wire: 'openai', baseUrl: 'https://api.deepseek.com/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'sk-…', capabilities: ['text'], models: { text: ['deepseek-chat', 'deepseek-reasoner'] }, listModels: 'openai', price: { input: 0.3, output: 1.2 }, keyUrl: 'https://platform.deepseek.com/api_keys', docs: 'https://api-docs.deepseek.com' }),
  P({ id: 'mistral', label: 'Mistral AI', group: 'text', wire: 'openai', baseUrl: 'https://api.mistral.ai/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'API-Schlüssel', capabilities: ['text', 'vision', 'embeddings', 'stt'], models: { text: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'], embeddings: ['mistral-embed'], stt: ['voxtral-mini-latest'] }, listModels: 'openai', price: { input: 2, output: 6 }, keyUrl: 'https://console.mistral.ai/api-keys', docs: 'https://docs.mistral.ai', verified: '2026-10', note: 'Globaler Endpunkt: Mistral legt hier keinen Verarbeitungsort fest. Für Verarbeitung in der EU „Mistral AI – EU-Endpunkt“ wählen (derselbe Schlüssel).' }),
  P({ id: 'xai', label: 'xAI (Grok)', group: 'text', wire: 'openai', baseUrl: 'https://api.x.ai/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'xai-…', capabilities: ['text', 'vision', 'image'], models: { text: ['grok-4', 'grok-4-fast', 'grok-3-mini'], image: ['grok-2-image'] }, listModels: 'openai', price: { input: 3, output: 15 }, keyUrl: 'https://console.x.ai', docs: 'https://docs.x.ai' }),
  P({ id: 'perplexity', label: 'Perplexity', group: 'text', wire: 'openai', baseUrl: 'https://api.perplexity.ai', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'pplx-…', capabilities: ['text'], models: { text: ['sonar', 'sonar-pro', 'sonar-reasoning'] }, listModels: 'none', price: { input: 1, output: 1 }, keyUrl: 'https://www.perplexity.ai/settings/api', docs: 'https://docs.perplexity.ai', note: 'Antwortet mit Web-Suche; Werkzeug-Aufrufe (für den Agenten) unterstützen nicht alle Modelle.' }),
  P({ id: 'cerebras', label: 'Cerebras', group: 'text', wire: 'openai', baseUrl: 'https://api.cerebras.ai/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'csk-…', capabilities: ['text'], models: { text: ['llama-3.3-70b', 'gpt-oss-120b', 'qwen-3-32b'] }, listModels: 'openai', price: { input: 0.85, output: 1.2 }, keyUrl: 'https://cloud.cerebras.ai', docs: 'https://inference-docs.cerebras.ai' }),
  P({ id: 'huggingface', label: 'Hugging Face (Router)', group: 'text', wire: 'openai', baseUrl: 'https://router.huggingface.co/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'hf_…', capabilities: ['text', 'vision'], models: { text: ['meta-llama/Llama-3.3-70B-Instruct', 'Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3'] }, listModels: 'openai', price: { input: 0.9, output: 0.9 }, keyUrl: 'https://huggingface.co/settings/tokens', docs: 'https://huggingface.co/docs/inference-providers' }),
  P({ id: 'azure', label: 'Azure OpenAI', group: 'text', wire: 'openai', baseUrl: '', customUrl: true, auth: 'header', authHeader: 'api-key', keyRequired: true, keyHint: 'Schlüssel der Azure-Ressource', capabilities: ['text', 'vision', 'image', 'embeddings', 'audio_tts', 'stt'], models: { text: [] }, listModels: 'none', price: { input: 1.25, output: 10 }, keyUrl: 'https://portal.azure.com/', docs: 'https://learn.microsoft.com/azure/ai-foundry/openai/', note: 'Adresse https://<ressource>.openai.azure.com, Modell = Name des Deployments. Mit …/openai/v1 am Ende wird die neue v1-API genutzt.' }),
  // --- more providers (gateways, open-model inference, EU hosting): services/ai-presets-extra.ts ---
  ...EXTRA_PRESETS,
  P({ id: 'ollama', label: 'Ollama', group: 'local', wire: 'openai', baseUrl: 'http://localhost:11434/v1', customUrl: true, auth: 'none', keyRequired: false, keyHint: 'meist leer', capabilities: ['text', 'vision', 'embeddings'], models: { text: ['llama3.1', 'qwen2.5', 'mistral-nemo'], embeddings: ['nomic-embed-text'] }, listModels: 'openai', price: { input: 0, output: 0 }, keyUrl: '', docs: 'https://github.com/ollama/ollama/blob/main/docs/openai.md', local: true, note: 'Für den Agenten ein Modell mit Werkzeug-Unterstützung wählen (z. B. llama3.1, qwen2.5).' }),
  P({ id: 'lmstudio', label: 'LM Studio', group: 'local', wire: 'openai', baseUrl: 'http://localhost:1234/v1', customUrl: true, auth: 'none', keyRequired: false, keyHint: 'meist leer', capabilities: ['text', 'vision', 'embeddings'], models: { text: [] }, listModels: 'openai', price: { input: 0, output: 0 }, keyUrl: '', docs: 'https://lmstudio.ai/docs/app/api/endpoints/openai', local: true }),
  P({ id: 'litellm', label: 'vLLM / LiteLLM-Proxy', group: 'local', wire: 'openai', baseUrl: 'http://localhost:4000/v1', customUrl: true, auth: 'bearer', keyRequired: false, keyHint: 'Schlüssel des Proxys (falls gesetzt)', capabilities: ['text', 'vision', 'embeddings', 'image', 'audio_tts', 'stt'], models: { text: [] }, listModels: 'openai', price: { input: 0, output: 0 }, keyUrl: '', docs: 'https://docs.litellm.ai/docs/simple_proxy', note: 'Auch für Amazon Bedrock, Vertex AI und andere: LiteLLM übersetzt sie in die OpenAI-Schnittstelle.' }),
  P({ id: 'custom', label: 'Benutzerdefiniert (OpenAI-kompatibel)', group: 'custom', wire: 'openai', baseUrl: '', customUrl: true, auth: 'bearer', keyRequired: false, keyHint: 'falls der Server einen verlangt', capabilities: ['text'], models: { text: [] }, listModels: 'openai', price: { input: 0, output: 0 }, keyUrl: '', docs: '' }),
  P({ id: 'fal', label: 'fal.ai', group: 'media', wire: 'http', baseUrl: 'https://fal.run', customUrl: false, auth: 'key', keyRequired: true, keyHint: 'Schlüssel aus dem fal-Dashboard', capabilities: ['image', 'video', 'audio_tts', 'audio_music', 'stt'], models: { image: ['fal-ai/flux/schnell', 'fal-ai/flux-pro/v1.1'], video: ['fal-ai/kling-video/v2.1/standard/text-to-video'], audio_tts: ['fal-ai/elevenlabs/tts/multilingual-v2'], stt: ['fal-ai/whisper'] }, listModels: 'none', price: { input: 0, output: 0 }, keyUrl: 'https://fal.ai/dashboard/keys', docs: 'https://docs.fal.ai', note: 'Auth-Header „Authorization: Key <Schlüssel>“. Warteschlange unter https://queue.fal.run.' }),
  P({ id: 'kie', label: 'kie.ai', group: 'media', wire: 'http', baseUrl: 'https://api.kie.ai', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'API-Schlüssel', capabilities: ['image', 'video', 'audio_music', 'audio_tts'], models: { image: ['gpt4o-image', 'flux-kontext-pro'], video: ['veo3_fast', 'runway-gen3'], audio_music: ['suno-v4.5'], audio_tts: ['elevenlabs/text-to-speech-turbo-2-5', 'elevenlabs/text-to-speech-multilingual-v2'] }, listModels: 'none', price: { input: 0, output: 0 }, keyUrl: 'https://kie.ai/api-key', docs: 'https://docs.kie.ai', note: 'Sprachausgabe: ElevenLabs über kie.ai – Turbo 2.5 spricht in der Sprache der App, Stimmen aus der kie-Liste (z. B. Brian).' }),
  P({ id: 'replicate', label: 'Replicate', group: 'media', wire: 'http', baseUrl: 'https://api.replicate.com/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'r8_…', capabilities: ['image', 'video', 'audio_tts', 'audio_music', 'stt'], models: { image: ['black-forest-labs/flux-schnell'], video: ['minimax/video-01'], audio_music: ['meta/musicgen'], stt: ['openai/whisper'] }, listModels: 'none', price: { input: 0, output: 0 }, keyUrl: 'https://replicate.com/account/api-tokens', docs: 'https://replicate.com/docs' }),
  P({ id: 'stability', label: 'Stability AI', group: 'media', wire: 'http', baseUrl: 'https://api.stability.ai', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'sk-…', capabilities: ['image', 'audio_music'], models: { image: ['stable-image-core', 'sd3.5-large'], audio_music: ['stable-audio-2'] }, listModels: 'none', price: { input: 0, output: 0 }, keyUrl: 'https://platform.stability.ai/account/keys', docs: 'https://platform.stability.ai/docs/api-reference' }),
  P({ id: 'elevenlabs', label: 'ElevenLabs', group: 'media', wire: 'http', baseUrl: 'https://api.elevenlabs.io', customUrl: false, auth: 'header', authHeader: 'xi-api-key', keyRequired: true, keyHint: 'sk_…', capabilities: ['audio_tts', 'audio_music', 'stt'], models: { audio_tts: ['eleven_multilingual_v2', 'eleven_flash_v2_5'], audio_music: ['music_v1'], stt: ['scribe_v1'] }, listModels: 'none', price: { input: 0, output: 0 }, keyUrl: 'https://elevenlabs.io/app/settings/api-keys', docs: 'https://elevenlabs.io/docs/api-reference', realtime: { audio_tts: true } }),
  P({ id: 'runway', label: 'Runway', group: 'media', wire: 'http', baseUrl: 'https://api.dev.runwayml.com/v1', customUrl: false, auth: 'bearer', headers: { 'x-runway-version': '2024-11-06' }, keyRequired: true, keyHint: 'key_…', capabilities: ['video', 'image'], models: { video: ['gen4_turbo'], image: ['gen4_image'] }, listModels: 'none', price: { input: 0, output: 0 }, keyUrl: 'https://dev.runwayml.com/', docs: 'https://docs.dev.runwayml.com' }),
  P({ id: 'luma', label: 'Luma AI', group: 'media', wire: 'http', baseUrl: 'https://api.lumalabs.ai/dream-machine/v1', customUrl: false, auth: 'bearer', keyRequired: true, keyHint: 'luma-…', capabilities: ['video', 'image'], models: { video: ['ray-2', 'ray-flash-2'], image: ['photon-1'] }, listModels: 'none', price: { input: 0, output: 0 }, keyUrl: 'https://lumalabs.ai/api/keys', docs: 'https://docs.lumalabs.ai' }),
  // --- Sprache (TTS & STT): eigene Stimme und Spracherkennung für Telefonagent, HyperLevel Agent, KI-Studio und Workflows ---
  P({ id: 'deepgram', label: 'Deepgram (Nova & Aura)', group: 'voice', wire: 'http', baseUrl: 'https://api.deepgram.com', customUrl: true, auth: 'token', keyRequired: true, keyHint: 'API-Schlüssel', capabilities: ['stt', 'audio_tts'], models: { stt: ['nova-3', 'nova-2'], audio_tts: ['aura-2-viktoria-de', 'aura-2-julius-de', 'aura-2-thalia-en'] }, listModels: 'none', price: { input: 0, output: 0 }, keyUrl: 'https://console.deepgram.com/', docs: 'https://developers.deepgram.com/docs', note: 'Echtzeit-Transkription (WebSocket, µ-law) und Aura-Stimmen – die schnellste Wahl fürs Telefon. EU-Adresse: https://api.eu.deepgram.com. Bei Aura ist die Stimme das Modell.', realtime: { stt: true, audio_tts: true } }),
  P({ id: 'cartesia', label: 'Cartesia (Sonic)', group: 'voice', wire: 'http', baseUrl: 'https://api.cartesia.ai', customUrl: false, auth: 'x-api-key', headers: { 'cartesia-version': '2025-04-16' }, keyRequired: true, keyHint: 'sk_car_…', capabilities: ['audio_tts', 'stt'], models: { audio_tts: ['sonic-2', 'sonic-turbo'], stt: ['ink-whisper'] }, listModels: 'none', price: { input: 0, output: 0 }, keyUrl: 'https://play.cartesia.ai/keys', docs: 'https://docs.cartesia.ai', note: 'Sehr niedrige Latenz für Live-Telefonate (streamt µ-law 8 kHz).', realtime: { audio_tts: true } }),
  P({ id: 'assemblyai', label: 'AssemblyAI', group: 'voice', wire: 'http', baseUrl: 'https://api.assemblyai.com', customUrl: true, auth: 'header', authHeader: 'authorization', keyRequired: true, keyHint: 'API-Schlüssel', capabilities: ['stt'], models: { stt: [] }, listModels: 'none', price: { input: 0, output: 0 }, keyUrl: 'https://www.assemblyai.com/dashboard/api-keys', docs: 'https://www.assemblyai.com/docs', note: 'Transkription mit Sprecher- und Spracherkennung; Echtzeit über WebSocket. EU-Adresse: https://api.eu.assemblyai.com. Modell leer = Standard des Anbieters.', realtime: { stt: true } }),
  P({ id: 'azure_speech', label: 'Azure Speech (Cognitive Services)', group: 'voice', wire: 'http', baseUrl: '', customUrl: true, auth: 'header', authHeader: 'ocp-apim-subscription-key', keyRequired: true, keyHint: 'Schlüssel der Speech-Ressource', capabilities: ['audio_tts', 'stt'], models: {}, listModels: 'none', price: { input: 0, output: 0 }, keyUrl: 'https://portal.azure.com/', docs: 'https://learn.microsoft.com/azure/ai-services/speech-service/', note: 'Adresse wie im Azure-Portal unter „Schlüssel und Endpunkt“, z. B. https://germanywestcentral.api.cognitive.microsoft.com. Die Stimme ist der Name der Neural-Stimme (de-DE-KatjaNeural).', realtime: { audio_tts: true } }),
  P({ id: 'google_speech', label: 'Google Cloud Speech (TTS & STT)', group: 'voice', wire: 'http', baseUrl: 'https://texttospeech.googleapis.com', customUrl: false, auth: 'header', authHeader: 'x-goog-api-key', keyRequired: true, keyHint: 'AIza… (API-Schlüssel mit Text-to-Speech und Speech-to-Text)', capabilities: ['audio_tts', 'stt'], models: { stt: ['latest_long', 'latest_short'] }, listModels: 'none', price: { input: 0, output: 0 }, keyUrl: 'https://console.cloud.google.com/apis/credentials', docs: 'https://cloud.google.com/text-to-speech/docs', note: 'Die Cloud-APIs „Text-to-Speech“ und „Speech-to-Text“ im Google-Projekt aktivieren. Für Gemini-Stimmen die Verbindung „Google Gemini“ nehmen.', realtime: { audio_tts: true } }),
  P({ id: 'speech_local', label: 'Lokaler Sprachserver (Kokoro, Piper, Whisper …)', group: 'local', wire: 'openai', baseUrl: 'http://localhost:8880/v1', customUrl: true, auth: 'bearer', keyRequired: false, keyHint: 'meist leer', capabilities: ['audio_tts', 'stt'], models: { audio_tts: ['kokoro', 'tts-1'], stt: ['whisper-1'] }, listModels: 'openai', price: { input: 0, output: 0 }, keyUrl: '', docs: 'https://github.com/remsky/Kokoro-FastAPI', local: true, note: 'Jeder Server mit OpenAI-Schnittstelle (/v1/audio/speech und /v1/audio/transcriptions): Kokoro-FastAPI, openedai-speech (Piper), Speaches / faster-whisper-server, whisper.cpp, LocalAI. Lokale Adressen gibt ein Agentur-Admin frei.', realtime: { audio_tts: true } }),
  P({ id: 'custom_http', label: 'Benutzerdefiniert (HTTP)', group: 'custom', wire: 'http', baseUrl: '', customUrl: true, auth: 'bearer', keyRequired: false, keyHint: 'falls der Dienst einen verlangt', capabilities: ['image'], models: {}, listModels: 'none', price: { input: 0, output: 0 }, keyUrl: '', docs: '' }),
];

export const presetById = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id);

/** Model ids as providers write them (gpt-5-mini, claude-sonnet-5-5, openai/gpt-5, llama3.1:8b, fal-ai/flux/dev, accounts/x/models/y, Cloudflare's @cf/meta/llama-3.1-8b-instruct). */
export const MODEL_RE = /^[A-Za-z0-9@][A-Za-z0-9._:/@+-]{0,159}$/;
/** Header names a user may add (no hop-by-hop or host-level headers). */
export const HEADER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'cookie', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'keep-alive', 'content-type']);
export const headerAllowed = (name: string) => HEADER_RE.test(name) && !FORBIDDEN_HEADERS.has(name.toLowerCase());

export interface ConnectionOptions {
  /** Azure: api-version of the deployments endpoint. */
  api_version?: string;
  /** USD per million input/output tokens (text). */
  price_in?: number;
  price_out?: number;
  /** Private/loopback addresses allowed (an agency admin's decision). */
  allow_private?: boolean;
  /** custom_http: the request template the media module (KI-Studio) fills in. */
  template?: Record<string, unknown>;
}

/** What `aiConnections.resolve` returns – the shape media modules and the agent build on. */
export interface Resolved {
  connectionId: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  /** Complete headers for a call: auth (per style), the preset's fixed headers, the user's extra headers. */
  headers: Record<string, string>;
  /** How the key is sent: 'bearer' | 'key' (Authorization: Key <k>) | 'header:<name>' | 'query:<name>' | 'none'. `headers` already carries it (except query). */
  authStyle: string;
  model: string;
  label: string;
  wire: Wire;
  capabilities: string[];
  options: ConnectionOptions;
  /** Signing secret for provider callbacks (e.g. kie.ai webhookHmacKey), if one is stored. */
  webhookSecret?: string;
}

/** The auth style as handed out by resolve(): header names folded in ("header:xi-api-key"). */
export function resolvedAuthStyle(style: AuthStyle, provider: string, authHeader?: string): string {
  const name = (authHeader || presetById(provider)?.authHeader || '').toLowerCase();
  if (style === 'x-api-key') return 'header:x-api-key';
  if (style === 'header') return name ? `header:${name}` : 'none';
  if (style === 'query') return name ? `query:${name}` : 'none';
  return style;
}

/** Auth header for a key in a given style. */
export function authHeaders(style: AuthStyle, key: string, headerName?: string): Record<string, string> {
  if (!key || style === 'none') return {};
  if (style === 'bearer') return { authorization: `Bearer ${key}` };
  if (style === 'x-api-key') return { 'x-api-key': key };
  if (style === 'key') return { authorization: `Key ${key}` };
  if (style === 'token') return { authorization: `Token ${key}` };
  // query: the key goes into the URL (?name=key) – done by the caller, never as a header.
  if (style === 'query') return {};
  return headerName && headerAllowed(headerName) ? { [headerName.toLowerCase()]: key } : {};
}

/** All headers of a connection (lower-case names; the user's extras can't override auth or the preset's). */
export function connectionHeaders(c: { provider: string; authStyle: AuthStyle; authHeader?: string; apiKey: string; extraHeaders?: Record<string, string> }): Record<string, string> {
  const preset = presetById(c.provider);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.extraHeaders ?? {})) if (headerAllowed(k)) out[k.toLowerCase()] = String(v);
  for (const [k, v] of Object.entries(preset?.headers ?? {})) out[k.toLowerCase()] = v;
  Object.assign(out, authHeaders(c.authStyle, c.apiKey, c.authHeader || preset?.authHeader));
  return out;
}

export const DEFAULT_AZURE_VERSION = '2024-10-21';

/** Chat endpoint and request quirks for a text connection. */
export function chatEndpoint(c: Pick<Resolved, 'provider' | 'baseUrl' | 'model' | 'headers' | 'options' | 'wire'>, app: { baseUrl: string; name: string } = { baseUrl: '', name: 'HyperLevel' }) {
  const base = c.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json', ...c.headers };
  if (c.wire === 'anthropic') {
    headers['anthropic-version'] ??= ANTHROPIC_VERSION;
    return { kind: 'anthropic' as const, url: `${base.replace(/\/v1$/, '')}/v1/messages`, headers, maxTokensParam: 'max_tokens' as const, streamUsage: false };
  }
  let url = `${base}/chat/completions`;
  if (c.provider === 'azure' && !/\/openai\/v1$/.test(base)) url = `${base}/openai/deployments/${encodeURIComponent(c.model)}/chat/completions?api-version=${encodeURIComponent(c.options.api_version || DEFAULT_AZURE_VERSION)}`;
  // App attribution: OpenRouter (https://openrouter.ai/docs/app-attribution – HTTP-Referer identifies the app, X-OpenRouter-Title is its
  // name, X-Title the older spelling), Requesty and Featherless take HTTP-Referer and X-Title as optional analytics headers.
  if (c.provider === 'openrouter' || c.provider === 'requesty' || c.provider === 'featherless') {
    if (app.baseUrl) headers['http-referer'] ??= app.baseUrl;
    headers['x-title'] ??= app.name;
    if (c.provider === 'openrouter') headers['x-openrouter-title'] ??= app.name;
  }
  const openaiLike = c.provider === 'openai' || c.provider === 'azure';
  return {
    kind: 'openai' as const,
    url,
    headers,
    // OpenAI's newer models only take max_completion_tokens; everyone else knows max_tokens.
    maxTokensParam: (openaiLike ? 'max_completion_tokens' : 'max_tokens') as 'max_tokens' | 'max_completion_tokens',
    streamUsage: openaiLike || ['openrouter', 'groq', 'together', 'fireworks', 'deepseek', 'xai', 'litellm', 'cerebras'].includes(c.provider),
  };
}

/** URL of the live model list, or null when the provider has none. */
export function modelsUrl(c: { provider: string; baseUrl: string }): string | null {
  const preset = presetById(c.provider);
  const base = c.baseUrl.replace(/\/+$/, '');
  if (!preset || preset.listModels === 'none') return c.provider === 'azure' && /\/openai\/v1$/.test(base) ? `${base}/models` : null;
  if (preset.listModels === 'anthropic') return `${base.replace(/\/v1$/, '')}/v1/models?limit=100`;
  return `${base}/models`;
}

/** Model ids from a /models answer (OpenAI, OpenRouter, Gemini's OpenAI layer, Anthropic, Ollama). */
export function parseModelList(data: any): string[] {
  const list: any[] = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
  const ids = list.map((m) => String(m?.id ?? m?.name ?? m?.model ?? '').replace(/^models\//, '')).filter((x) => x && x.length < 200);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/** USD per million tokens for text calls of a connection. */
export function textPrice(c: { provider: string; model: string; options?: ConnectionOptions }): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  const o = c.options ?? {};
  if (c.provider === 'anthropic' && o.price_in === undefined) {
    const t = CLAUDE_PRICES[c.model] ?? CLAUDE_PRICES['claude-sonnet-5-5'];
    return { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite };
  }
  const live = o.price_in === undefined && o.price_out === undefined ? livePrice(c.provider, c.model) : undefined;
  const p = live ? { input: live.in, output: live.out } : (presetById(c.provider)?.price ?? { input: 0, output: 0 });
  const input = Number.isFinite(o.price_in) ? Number(o.price_in) : p.input;
  const output = Number.isFinite(o.price_out) ? Number(o.price_out) : p.output;
  return { input, output, cacheRead: input / 10, cacheWrite: input * 1.25 };
}

/** Cost in micro-dollars of a text call ($/MTok × tokens = µ$). */
export function textCost(c: { provider: string; model: string; options?: ConnectionOptions }, u: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number }): number {
  const p = textPrice(c);
  return Math.round(u.input_tokens * p.input + u.output_tokens * p.output + u.cache_read_tokens * p.cacheRead + u.cache_write_tokens * p.cacheWrite);
}

/** Whether a base URL is acceptable: http(s), no credentials in it, private targets only when allowed. */
export function checkBaseUrl(raw: string, allowPrivate: boolean): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'Die Adresse ist keine gültige URL (z. B. http://localhost:11434/v1).';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Nur http(s)-Adressen.';
  if (u.username || u.password) return 'Bitte keine Zugangsdaten in die Adresse schreiben – dafür gibt es das Schlüssel-Feld.';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || (isIP(host) > 0 && isPrivateIp(host));
  if (local && !allowPrivate && process.env.PGHL_ALLOW_PRIVATE_FETCH !== '1') return 'Diese Adresse liegt in einem lokalen/privaten Netz. Das darf nur ein Agentur-Admin freigeben („Lokales Netz erlauben“).';
  if (u.protocol === 'http:' && !local) return 'Für Server im Internet bitte https:// verwenden.';
  return null;
}

function guardedLookup(hostname: string, options: any, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, '');
    const list = (addresses as unknown as LookupAddress[]) ?? [];
    if (process.env.PGHL_ALLOW_PRIVATE_FETCH !== '1' && list.some((a) => isPrivateIp(a.address))) {
      const e: NodeJS.ErrnoException = new Error('Ziel liegt in einem internen Netz und ist gesperrt');
      e.code = 'EPRIVATE';
      return cb(e, '');
    }
    if (options?.all) return cb(null, list);
    cb(null, list[0]?.address ?? '', list[0]?.family);
  });
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * fetch() for user-supplied base URLs with a streaming body. Without `allowPrivate` the resolved IP
 * of every connection is checked (no DNS rebinding into the internal network); redirects are not
 * followed (an API endpoint has no business sending the key elsewhere).
 */
export function guardedFetch(allowPrivate: boolean): FetchLike {
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return reject(new Error('Ungültige URL'));
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('Nur http(s)-Adressen'));
      const host = u.hostname.replace(/^\[|\]$/g, '');
      const open = allowPrivate || process.env.PGHL_ALLOW_PRIVATE_FETCH === '1';
      if (!open && isIP(host) && isPrivateIp(host)) return reject(new Error('Ziel liegt in einem internen Netz und ist gesperrt'));
      const headers: Record<string, string> = {};
      new Headers(init.headers as HeadersInit | undefined).forEach((v, k) => (headers[k] = v));
      const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, { method: init.method ?? 'GET', headers, ...(open ? {} : { lookup: guardedLookup as any }), signal: init.signal ?? undefined }, (res) => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : String(v));
        const status = res.statusCode ?? 502;
        const empty = status === 204 || status === 304;
        if (empty) res.resume();
        resolve(new Response(empty ? null : (Readable.toWeb(res) as unknown as ReadableStream), { status, headers: h }));
      });
      req.on('error', reject);
      if (typeof init.body === 'string') req.write(init.body);
      req.end();
    });
}

/** The public view of a preset (for the card grid). */
export function presetOut(p: Preset) {
  return { id: p.id, label: p.label, group: p.group, wire: p.wire, base_url: p.baseUrl, custom_url: p.customUrl, auth: p.auth, auth_header: p.authHeader ?? '', key_required: p.keyRequired, key_hint: p.keyHint, capabilities: p.capabilities, models: p.models, list_models: p.listModels !== 'none', price: p.price, key_url: p.keyUrl, docs: p.docs, note: p.note ?? '', local: !!p.local, realtime: p.realtime ?? {}, eu: p.eu ?? null, tags: [...(p.tags ?? []), ...(p.local || p.group === 'local' ? ['local'] : [])], referral: p.referral ?? p.id, verified: p.verified ?? '' };
}
