import { authFor, baseOf, ensureOk, jsonCall, multipart } from './http.js';
import { MAX_INPUT_BYTES, orientation } from './media.js';
import { ProviderError, type Adapter, type AdapterCtx, type Step } from './types.js';

/**
 * OpenAI (https://github.com/openai/openai-openapi), `Authorization: Bearer`:
 * - images: POST /v1/images/generations {model, prompt, size, n} → data[].b64_json (+ usage);
 *   with a reference image POST /v1/images/edits (JSON) {model, prompt, images: [{image_url}]}
 * - video (Sora): POST /v1/videos {model, prompt, seconds, size} → id; GET /v1/videos/{id} →
 *   queued|in_progress|completed|failed; GET /v1/videos/{id}/content → MP4 (with the key)
 * - speech: POST /v1/audio/speech {model, input, voice, response_format: mp3} → audio bytes
 * - transcription: POST /v1/audio/transcriptions (multipart file + model) → {text}
 */

const BASE = 'https://api.openai.com/v1';
export const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];

function base(ctx: Pick<AdapterCtx, 'conn'>): string {
  const b = baseOf(ctx.conn, BASE);
  return /api\.openai\.com$/.test(b) ? `${b}/v1` : b;
}

const imageSize = (aspect?: string) => {
  const o = orientation(aspect);
  return o === 'square' ? '1024x1024' : o === 'landscape' ? '1536x1024' : '1024x1536';
};
const videoSize = (aspect?: string) => (orientation(aspect) === 'portrait' ? '720x1280' : '1280x720');
const seconds = (d?: number) => (!d ? '4' : d <= 4 ? '4' : d <= 8 ? '8' : '12');

export const openaiAdapter: Adapter = {
  id: 'openai',
  label: 'OpenAI',
  capabilities: ['image', 'video', 'audio_tts', 'stt'],
  defaultBase: BASE,
  defaultAuth: 'bearer',
  trustedHosts: (b) => [new URL(b).hostname],
  models: {
    image: [
      { id: 'gpt-image-1', label: 'GPT Image 1' },
      { id: 'gpt-image-1-mini', label: 'GPT Image 1 mini (günstig)' },
      { id: 'gpt-image-1.5', label: 'GPT Image 1.5' },
      { id: 'gpt-image-2', label: 'GPT Image 2' },
    ],
    video: [
      { id: 'sora-2', label: 'Sora 2' },
      { id: 'sora-2-pro', label: 'Sora 2 Pro' },
    ],
    audio_tts: [
      { id: 'gpt-4o-mini-tts', label: 'GPT-4o mini TTS (mit Stil-Anweisung)' },
      { id: 'tts-1', label: 'TTS-1' },
      { id: 'tts-1-hd', label: 'TTS-1 HD' },
    ],
    stt: [
      { id: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe' },
      { id: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini Transcribe' },
      { id: 'whisper-1', label: 'Whisper' },
    ],
  },
  voices: async () => OPENAI_VOICES.map((v) => ({ id: v, name: v[0].toUpperCase() + v.slice(1) })),
  async submit(ctx) {
    const { headers } = authFor(ctx.conn, 'bearer');
    const b = base(ctx);
    const p = ctx.input.params ?? {};
    if (ctx.capability === 'image') {
      const model = ctx.model || 'gpt-image-1';
      const body: Record<string, any> = { model, prompt: ctx.input.prompt, size: imageSize(ctx.input.aspect_ratio), n: 1 };
      if (ctx.input.image) {
        // Our own files go inline (a data URL), so it also works when HyperLevel is not reachable from outside.
        const ref = ctx.input.image;
        const url = ref.local ? await ctx.bytes(ref, 20 * 1024 * 1024).then((f) => `data:${f.mime};base64,${f.data.toString('base64')}`) : ref.url;
        body.images = [{ image_url: url }];
      }
      const r = await jsonCall(ctx.fetch, 'POST', `${b}/images/${ctx.input.image ? 'edits' : 'generations'}`, headers, { ...body, ...p }, 240_000, 'OpenAI');
      const outputs = ((r.data ?? []) as any[]).map((d) => (d.b64_json ? { data: Buffer.from(d.b64_json, 'base64') } : d.url ? { url: d.url } : null)).filter(Boolean) as any[];
      if (!outputs.length) throw new ProviderError('OpenAI hat kein Bild geliefert');
      const tokens = Number(r.usage?.total_tokens);
      return { status: 'done', outputs, cost: Number.isFinite(tokens) && tokens > 0 ? { amount: tokens, unit: 'Tokens' } : undefined };
    }
    if (ctx.capability === 'video') {
      const body = { model: ctx.model || 'sora-2', prompt: ctx.input.prompt, seconds: seconds(ctx.input.duration), size: videoSize(ctx.input.aspect_ratio), ...p };
      const v = await jsonCall(ctx.fetch, 'POST', `${b}/videos`, headers, body, 60_000, 'OpenAI');
      if (!v?.id) throw new ProviderError('OpenAI hat keine Video-ID geliefert');
      return { status: 'pending', state: { id: v.id }, pollAfterMs: 10_000 };
    }
    if (ctx.capability === 'audio_tts') {
      const text = ctx.input.prompt.slice(0, 4096);
      const model = ctx.model || 'gpt-4o-mini-tts';
      const body: Record<string, any> = {
        model,
        input: text,
        voice: ctx.input.voice || 'alloy',
        response_format: 'mp3',
        // gpt-4o-mini-tts is steered by an instruction, the other models by a speed factor.
        ...(/gpt-4o-mini-tts/.test(model) ? (ctx.input.instructions ? { instructions: ctx.input.instructions } : {}) : ctx.input.speed && ctx.input.speed !== 1 ? { speed: Math.max(0.25, Math.min(4, ctx.input.speed)) } : {}),
        ...p,
      };
      const r = await ctx.fetch(`${b}/audio/speech`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 120_000, maxBytes: 60 * 1024 * 1024 });
      ensureOk(r, 'OpenAI');
      return { status: 'done', outputs: [{ data: r.body, mime: 'audio/mpeg' }], cost: { amount: text.length, unit: 'Zeichen' } };
    }
    if (ctx.capability === 'stt') {
      if (!ctx.input.audio) throw new ProviderError('Bitte eine Audio- oder Videodatei angeben');
      const file = await ctx.bytes(ctx.input.audio, MAX_INPUT_BYTES);
      const form = multipart({
        model: ctx.model || 'gpt-4o-transcribe',
        response_format: 'json',
        language: ctx.input.language,
        prompt: ctx.input.prompt || undefined,
        file: { filename: ctx.input.audio.name || `audio${extOf(file.mime)}`, contentType: file.mime, data: file.data },
        ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : (v as any)])),
      });
      const r = await ctx.fetch(`${b}/audio/transcriptions`, { method: 'POST', headers: { ...headers, 'content-type': form.contentType }, body: form.body, timeoutMs: 300_000 });
      ensureOk(r, 'OpenAI');
      const j = r.json();
      const text = typeof j?.text === 'string' ? j.text : r.text();
      return { status: 'done', outputs: [], text };
    }
    throw new ProviderError('OpenAI kann das nicht');
  },
  async poll(ctx, state): Promise<Step> {
    const { headers } = authFor(ctx.conn, 'bearer');
    const b = base(ctx);
    const v = await jsonCall(ctx.fetch, 'GET', `${b}/videos/${encodeURIComponent(state.id)}`, headers, undefined, 30_000, 'OpenAI');
    if (v.status === 'completed') return { status: 'done', outputs: [{ url: `${b}/videos/${encodeURIComponent(state.id)}/content`, auth: true }] };
    if (v.status === 'failed') return { status: 'failed', error: `OpenAI: ${String(v.error?.message ?? 'Video fehlgeschlagen').slice(0, 300)}` };
    return { status: 'pending', state, progress: Number(v.progress) || undefined, pollAfterMs: 15_000 };
  },
};

function extOf(mime: string): string {
  return { 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/mp4': '.m4a', 'video/mp4': '.mp4', 'audio/ogg': '.ogg', 'audio/webm': '.webm', 'video/webm': '.webm', 'audio/flac': '.flac' }[mime] ?? '.mp3';
}
