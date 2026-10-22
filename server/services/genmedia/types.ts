/**
 * AI media generation (KI-Studio) – shared types for the job engine and the provider adapters.
 * Provider keys never live here: they come from the BYOK registry (`app.services.aiConnections`,
 * owned by the agent module) at the moment a call is made and are never stored in a job.
 */

export type Capability = 'image' | 'video' | 'audio_tts' | 'audio_music' | 'stt';
export const CAPABILITIES: Capability[] = ['image', 'video', 'audio_tts', 'audio_music', 'stt'];
export const CAPABILITY_LABEL: Record<Capability, string> = {
  image: 'Bild',
  video: 'Video',
  audio_tts: 'Text in Sprache',
  audio_music: 'Musik & Sound',
  stt: 'Sprache in Text',
};

/** What `app.services.aiConnections.resolve()` hands out (contract with feat/agent). */
export interface AiConnection {
  connectionId: string;
  /** Preset id: fal, kie, replicate, openai, gemini, stability, elevenlabs, runway, luma, custom_http, … */
  provider: string;
  baseUrl?: string;
  apiKey: string;
  headers?: Record<string, string>;
  /** bearer | key | header:<name> | query:<name> | basic | none (lenient: a bare header name works too). */
  authStyle?: string;
  model?: string;
  label?: string;
  /** Optional signing secret for provider callbacks (kie.ai "webhookHmacKey"), if the registry keeps one. */
  webhookSecret?: string;
  /** Optional extra settings of the connection (e.g. a custom HTTP template). */
  options?: Record<string, any>;
}

export interface ConnectionSummary {
  id: string;
  provider: string;
  label: string;
  model?: string;
  capabilities?: string[];
}

/** The BYOK registry as far as media generation needs it (declared here until feat/agent lands). */
export interface AiConnectionsService {
  resolve(locationId: string, capability: Capability, connectionId?: string | null): AiConnection | null | Promise<AiConnection | null>;
  list(locationId: string, capability?: Capability): unknown[] | Promise<unknown[]>;
}

export const BYOK_MISSING = 'Bitte zuerst unter Einstellungen → KI-Anbieter (BYOK) einen Anbieter verbinden';

/** A reference file handed to a provider: a public URL plus, when we hold the bytes, where they are. */
export interface Ref {
  url: string;
  mime?: string;
  name?: string;
  local?: { dir: 'uploads' | 'genmedia'; file: string };
}

/** Normalised request of one job (stored as JSON; no secrets). */
export interface GenInput {
  prompt: string;
  negative_prompt?: string;
  aspect_ratio?: string;
  duration?: number;
  seed?: number;
  voice?: string;
  language?: string;
  /** Speech: playback speed (1 = normal) and a style instruction (OpenAI gpt-4o-mini-tts) – adapters that know them use them. */
  speed?: number;
  instructions?: string;
  image?: Ref;
  audio?: Ref;
  video?: Ref;
  /** Raw provider fields ("Erweiterte Parameter (JSON)") – merged last, so they win. */
  params?: Record<string, any>;
  /** kie.ai generic task: endpoint path + JSON body (+ optional record path). */
  kie_task?: { endpoint: string; body: Record<string, any>; poll_path?: string };
  /** custom_http: id of a stored HTTP template (if the connection carries none). */
  template_id?: string;
}

export interface Cost {
  /** Amount as the provider reports it, e.g. 60 (credits) or 0.04 (USD). */
  amount?: number;
  unit?: string;
  /** Free text hint, e.g. "3,4 s Rechenzeit" or "≈ 8 Credits (Preisliste)". */
  note?: string;
  estimated?: boolean;
}

/** One produced file: a URL to download (optionally with auth headers) or the bytes themselves. */
export type Output = { url: string; mime?: string; auth?: boolean } | { data: Buffer; mime?: string };

export type Step =
  | { status: 'pending'; state: Record<string, any>; pollAfterMs?: number; progress?: number }
  | { status: 'done'; outputs: Output[]; text?: string; cost?: Cost; state?: Record<string, any> }
  | { status: 'failed'; error: string };

export interface GmResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: Buffer;
  text(): string;
  json(): any;
}

export interface GmRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  maxBytes?: number;
  /** The connection may reach private/LAN addresses (an agency admin allowed it: `options.allow_private`). */
  allowPrivate?: boolean;
}

export interface HttpTemplate {
  url: string;
  method?: 'GET' | 'POST' | 'PUT';
  headers?: Record<string, string>;
  /** JSON template with {{prompt}}, {{negative_prompt}}, {{aspect_ratio}}, {{duration}}, {{seed}}, {{voice}}, {{model}}, {{image_url}}, {{audio_url}}, {{params.x}}. */
  body?: string;
  /** Path to the media URL(s) in the (final) response, e.g. `images[0].url`, `output`, `data[*].url`. */
  result_path?: string;
  /** `url` (default) or `base64` (the value is the file itself). */
  result_type?: 'url' | 'base64';
  result_mime?: string;
  /** Speech-to-text: path to the text. */
  text_path?: string;
  poll?: {
    /** May use {{response.<path>}} from the first answer, e.g. https://api.x.com/v1/tasks/{{response.id}} */
    url: string;
    method?: 'GET' | 'POST';
    body?: string;
    done_path: string;
    done_values: string[];
    fail_path?: string;
    fail_values?: string[];
    error_path?: string;
    interval_s?: number;
    /** Where the media URL is in the poll answer (defaults to result_path). */
    result_path?: string;
  };
}

export interface AdapterCtx {
  conn: AiConnection;
  model: string;
  capability: Capability;
  input: GenInput;
  /** Public URL the provider may call when done (null when HyperLevel is not reachable from outside). */
  callbackUrl: string | null;
  /** Outbound HTTP (test hook `app.services.genmediaFetch` or a guarded request). */
  fetch(url: string, init?: GmRequest): Promise<GmResponse>;
  /** Bytes of a reference file (local read or guarded download). */
  bytes(ref: Ref, maxBytes?: number): Promise<{ data: Buffer; mime: string }>;
  /** custom_http: the template to use. */
  template?: HttpTemplate | null;
}

export interface WebhookIn {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  body: any;
}

export interface ModelHint {
  id: string;
  label: string;
  /** Needs a reference image (image-to-image / image-to-video). */
  ref?: boolean;
}

/** One voice a provider offers (language as the provider writes it, e.g. de-DE or German). */
export interface VoiceEntry {
  id: string;
  name: string;
  preview?: string;
  lang?: string;
  gender?: string;
}

export interface Adapter {
  id: string;
  label: string;
  capabilities: Capability[];
  models: Partial<Record<Capability, ModelHint[]>>;
  defaultBase: string;
  /** How the key is sent when the connection says nothing. */
  defaultAuth: string;
  /** Hosts that may receive the provider key when downloading a result (besides the API host). */
  trustedHosts?: (base: string) => string[];
  /** Static voice list or a call to the provider. */
  voices?: (ctx: Pick<AdapterCtx, 'conn' | 'fetch'> & { language?: string }) => Promise<VoiceEntry[]>;
  submit(ctx: AdapterCtx): Promise<Step>;
  poll?(ctx: AdapterCtx, state: Record<string, any>): Promise<Step>;
  /**
   * A provider called our per-job callback URL. Return a step when the message is signed and the
   * signature checked out; `null` means "not verifiable – poll the provider instead". Throw a
   * 401-ish error for a signature that is present but wrong.
   */
  webhook?(ctx: AdapterCtx, state: Record<string, any>, req: WebhookIn): Promise<Step | null>;
  cancel?(ctx: AdapterCtx, state: Record<string, any>): Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public retryable = false,
    public status = 0,
  ) {
    super(message);
  }
}
