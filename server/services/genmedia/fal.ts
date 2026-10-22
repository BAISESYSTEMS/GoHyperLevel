import { createPublicKey, createHash, verify as cryptoVerify } from 'node:crypto';
import { authFor, baseOf, deepMediaUrls, ensureOk, jsonCall, urlsIn } from './http.js';
import { orientation } from './media.js';
import { ProviderError, type Adapter, type AdapterCtx, type Output, type Step } from './types.js';

/**
 * fal.ai – queue API (https://fal.ai/docs/documentation/model-apis/inference/queue):
 * POST https://queue.fal.run/{model_id}[?fal_webhook=…] with `Authorization: Key <key>` →
 * {request_id, status_url, response_url}; GET status_url → IN_QUEUE | IN_PROGRESS | COMPLETED
 * (+ error); GET response_url → the model's output. Any model id works; the input is built from
 * the generic fields and the raw JSON parameters win.
 * Webhooks are signed with ED25519 (JWKS at https://rest.fal.ai/.well-known/jwks.json, headers
 * X-Fal-Webhook-Request-Id/-User-Id/-Timestamp/-Signature over id\nuser\nts\nsha256(body)).
 */

const QUEUE = 'https://queue.fal.run';
export const FAL_JWKS = 'https://rest.fal.ai/.well-known/jwks.json';

/** flux/dev-style models take `image_size` names instead of an aspect ratio. */
function imageSize(aspect?: string): string | undefined {
  if (!aspect) return undefined;
  const o = orientation(aspect);
  if (o === 'square') return 'square_hd';
  const wide = ['16:9', '21:9', '9:16'].includes(aspect);
  return o === 'landscape' ? (wide ? 'landscape_16_9' : 'landscape_4_3') : wide ? 'portrait_16_9' : 'portrait_4_3';
}

export function falInput(ctx: AdapterCtx): Record<string, any> {
  const { input, capability, model } = ctx;
  const m = model.toLowerCase();
  const out: Record<string, any> = {};
  if (capability === 'audio_tts') {
    out.text = input.prompt;
    if (input.voice) out.voice = input.voice;
  } else if (capability === 'stt') {
    if (input.audio) out.audio_url = input.audio.url;
    if (input.language) out.language = input.language;
  } else {
    out.prompt = input.prompt;
    if (input.negative_prompt) out.negative_prompt = input.negative_prompt;
    if (input.seed !== undefined) out.seed = input.seed;
    if (input.aspect_ratio) {
      if (capability === 'image' && /(^|\/)flux(-lora|-krea|-general)?\/(dev|schnell|krea)|flux-lora|flux\/dev|fast-sdxl|stable-diffusion/.test(m)) out.image_size = imageSize(input.aspect_ratio);
      else out.aspect_ratio = input.aspect_ratio;
    }
    if (input.duration) {
      // Veo wants "8s", Kling "5" (string), most others a number.
      out.duration = /veo/.test(m) ? `${input.duration}s` : /kling|hailuo|minimax/.test(m) ? String(input.duration) : input.duration;
    }
    if (capability === 'audio_music' && input.duration) out.seconds_total = input.duration;
    if (input.image) {
      out.image_url = input.image.url;
      if (capability === 'image') out.image_urls = [input.image.url];
    }
  }
  return { ...out, ...(input.params ?? {}) };
}

/** Output files of a fal result (images, image, video, audio, audio_url, audio_file, …). */
export function falOutputs(data: any): Output[] {
  if (!data || typeof data !== 'object') return [];
  const picks = [data.images, data.image, data.video, data.videos, data.audio, data.audio_url, data.audio_file, data.output, data.file];
  let urls: string[] = [];
  for (const p of picks) urls.push(...urlsIn(p));
  urls = [...new Set(urls)];
  if (!urls.length) urls = deepMediaUrls(data);
  return urls.map((url) => ({ url }));
}

function falText(data: any): string | undefined {
  if (typeof data?.text === 'string') return data.text;
  if (Array.isArray(data?.chunks)) return data.chunks.map((c: any) => c.text ?? '').join(' ').trim();
  return undefined;
}

function finish(ctx: AdapterCtx, data: any, metrics?: any): Step {
  const secs = Number(metrics?.inference_time);
  const cost = Number.isFinite(secs) && secs > 0 ? { note: `${secs.toFixed(1).replace('.', ',')} s Rechenzeit` } : undefined;
  if (ctx.capability === 'stt') {
    const text = falText(data);
    if (text === undefined) return { status: 'failed', error: 'fal.ai hat keinen Text geliefert' };
    return { status: 'done', outputs: [], text, cost };
  }
  const outputs = falOutputs(data);
  if (!outputs.length) return { status: 'failed', error: 'fal.ai hat keine Datei geliefert' };
  return { status: 'done', outputs, cost };
}

/** Status/result URLs use only owner/app of the model id (fal-ai/flux/dev → fal-ai/flux). */
const appId = (model: string) => model.replace(/^\/+/, '').split('/').slice(0, 2).join('/');

function queueBase(ctx: AdapterCtx): string {
  const b = baseOf(ctx.conn, QUEUE);
  return /^https:\/\/(fal\.run|api\.fal\.ai)$/.test(b) ? QUEUE : b;
}

// --- webhook signature (ED25519, keys from fal's JWKS) -----------------------------------------------
let jwksCache: { at: number; keys: string[] } | null = null;
export const resetFalJwks = () => (jwksCache = null);

async function falKeys(ctx: AdapterCtx): Promise<string[]> {
  if (jwksCache && Date.now() - jwksCache.at < 12 * 3600_000) return jwksCache.keys;
  const r = await ctx.fetch(FAL_JWKS, { timeoutMs: 10_000 });
  if (!r.ok) throw new ProviderError('fal.ai-Schlüsselliste nicht erreichbar', true);
  const keys = ((r.json()?.keys ?? []) as any[]).map((k) => String(k?.x ?? '')).filter(Boolean);
  jwksCache = { at: Date.now(), keys };
  return keys;
}

export function falMessage(requestId: string, userId: string, ts: string, rawBody: string | Buffer): Buffer {
  const hash = createHash('sha256').update(rawBody).digest('hex');
  return Buffer.from([requestId, userId, ts, hash].join('\n'), 'utf8');
}

function verifyEd25519(xB64url: string, msg: Buffer, sigHex: string): boolean {
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: xB64url }, format: 'jwk' });
    return cryptoVerify(null, msg, key, Buffer.from(sigHex, 'hex'));
  } catch {
    return false;
  }
}

const header = (h: Record<string, any>, name: string) => {
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? String(v[0] ?? '') : v === undefined ? '' : String(v);
};

export const falAdapter: Adapter = {
  id: 'fal',
  label: 'fal.ai',
  capabilities: ['image', 'video', 'audio_tts', 'audio_music', 'stt'],
  defaultBase: QUEUE,
  defaultAuth: 'key',
  models: {
    image: [
      { id: 'fal-ai/nano-banana-2', label: 'Nano Banana 2 (Google)' },
      { id: 'fal-ai/flux/dev', label: 'FLUX.1 [dev]' },
      { id: 'fal-ai/flux/schnell', label: 'FLUX.1 [schnell] – schnell & günstig' },
      { id: 'fal-ai/flux-pro/v1.1-ultra', label: 'FLUX 1.1 Pro Ultra' },
      { id: 'fal-ai/recraft/v4/pro/text-to-image', label: 'Recraft V4 Pro (Design)' },
      { id: 'fal-ai/flux-pro/kontext', label: 'FLUX Kontext Pro (Bild bearbeiten)', ref: true },
      { id: 'fal-ai/nano-banana-2/edit', label: 'Nano Banana 2 Edit', ref: true },
    ],
    video: [
      { id: 'fal-ai/veo3.1', label: 'Veo 3.1 (mit Ton)' },
      { id: 'fal-ai/veo3', label: 'Veo 3' },
      { id: 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video', label: 'Kling 2.5 Turbo Pro' },
      { id: 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video', label: 'Kling 2.5 Turbo Pro – Bild zu Video', ref: true },
      { id: 'fal-ai/sora-2/text-to-video', label: 'Sora 2' },
      { id: 'fal-ai/minimax/hailuo-02/standard/text-to-video', label: 'MiniMax Hailuo 02' },
    ],
    audio_tts: [
      { id: 'fal-ai/elevenlabs/tts/multilingual-v2', label: 'ElevenLabs Multilingual v2' },
      { id: 'fal-ai/minimax/speech-02-hd', label: 'MiniMax Speech-02 HD' },
      { id: 'fal-ai/chatterbox/text-to-speech', label: 'Chatterbox TTS' },
    ],
    audio_music: [
      { id: 'fal-ai/lyria2', label: 'Lyria 2 (Google)' },
      { id: 'fal-ai/stable-audio', label: 'Stable Audio' },
    ],
    stt: [
      { id: 'fal-ai/wizper', label: 'Wizper (Whisper v3, schnell)' },
      { id: 'fal-ai/whisper', label: 'Whisper' },
    ],
  },
  async submit(ctx) {
    if (!ctx.model) throw new ProviderError('Bitte eine fal.ai-Modell-ID angeben, z. B. fal-ai/flux/dev');
    const { headers, query } = authFor(ctx.conn, 'key');
    const url = new URL(`${queueBase(ctx)}/${ctx.model.replace(/^\/+/, '')}`);
    if (ctx.callbackUrl) url.searchParams.set('fal_webhook', ctx.callbackUrl);
    if (query) url.searchParams.set(query[0], query[1]);
    const r = await jsonCall(ctx.fetch, 'POST', url.toString(), headers, falInput(ctx), 60_000, 'fal.ai');
    if (!r.request_id) throw new ProviderError('fal.ai hat keine Auftrags-ID geliefert');
    return { status: 'pending', state: { request_id: r.request_id, status_url: r.status_url, response_url: r.response_url }, pollAfterMs: ctx.capability === 'video' ? 8000 : 2500 };
  },
  async poll(ctx, state) {
    const { headers } = authFor(ctx.conn, 'key');
    const base = queueBase(ctx);
    // Use the URLs fal returned – but only on fal's own queue host (they carry our key).
    const sameHost = (u?: string) => {
      try {
        return !!u && new URL(u).host === new URL(base).host;
      } catch {
        return false;
      }
    };
    const statusUrl = sameHost(state.status_url) ? state.status_url : `${base}/${appId(ctx.model)}/requests/${state.request_id}/status`;
    const s = await jsonCall(ctx.fetch, 'GET', statusUrl, headers, undefined, 30_000, 'fal.ai');
    if (s.status === 'IN_QUEUE' || s.status === 'IN_PROGRESS') return { status: 'pending', state, pollAfterMs: ctx.capability === 'video' ? 10_000 : 3000 };
    if (s.status !== 'COMPLETED') return { status: 'pending', state, pollAfterMs: 5000 };
    if (s.error) return { status: 'failed', error: `fal.ai: ${String(s.error).slice(0, 300)}` };
    const responseUrl = sameHost(state.response_url) ? state.response_url : sameHost(s.response_url) ? s.response_url : `${base}/${appId(ctx.model)}/requests/${state.request_id}`;
    const r = await ctx.fetch(responseUrl, { headers: { accept: 'application/json', ...headers }, timeoutMs: 30_000 });
    if (r.status === 422 || r.status === 400) return { status: 'failed', error: `fal.ai: ${r.text().slice(0, 300)}` };
    ensureOk(r, 'fal.ai');
    return finish(ctx, r.json(), s.metrics);
  },
  async webhook(ctx, state, req) {
    const rid = header(req.headers, 'x-fal-webhook-request-id');
    const uid = header(req.headers, 'x-fal-webhook-user-id');
    const ts = header(req.headers, 'x-fal-webhook-timestamp');
    const sig = header(req.headers, 'x-fal-webhook-signature');
    if (!rid || !uid || !ts || !sig) return null;
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) throw new ProviderError('Signatur abgelaufen', false, 401);
    let keys: string[];
    try {
      keys = await falKeys(ctx);
    } catch {
      return null;
    }
    const msg = falMessage(rid, uid, ts, req.rawBody);
    if (!keys.some((k) => verifyEd25519(k, msg, sig))) throw new ProviderError('Signatur ungültig', false, 401);
    const body = req.body ?? {};
    if (state.request_id && body.request_id && body.request_id !== state.request_id) throw new ProviderError('Falscher Auftrag', false, 401);
    if (body.status === 'ERROR') return { status: 'failed', error: `fal.ai: ${String(body.error ?? 'Fehler').slice(0, 300)}` };
    if (!body.payload) return null; // too large for the webhook → fetch it from the queue
    return finish(ctx, body.payload);
  },
  async cancel(ctx, state) {
    const { headers } = authFor(ctx.conn, 'key');
    const base = queueBase(ctx);
    await ctx.fetch(`${base}/${appId(ctx.model)}/requests/${state.request_id}/cancel`, { method: 'PUT', headers, timeoutMs: 10_000 }).catch(() => undefined);
  },
};
