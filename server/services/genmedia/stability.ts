import { authFor, baseOf, ensureOk, multipart } from './http.js';
import { ProviderError, type Adapter, type AdapterCtx, type Step } from './types.js';

/**
 * Stability AI – REST v2beta, `Authorization: Bearer`, multipart/form-data, synchronous:
 * POST /v2beta/stable-image/generate/{ultra|core|sd3} (prompt, negative_prompt, aspect_ratio,
 * seed, output_format, optional image + strength) with `Accept: image/*` → image bytes,
 * header finish-reason (CONTENT_FILTERED) and seed; POST /v2beta/audio/stable-audio-2/text-to-audio
 * (prompt, duration, output_format) with `Accept: audio/*` → audio bytes.
 * No cost in the answer: the hint uses Stability's credit price list.
 */

const BASE = 'https://api.stability.ai';

const IMAGE_MODELS: Record<string, { path: string; model?: string; credits: number }> = {
  'stable-image-ultra': { path: 'stable-image/generate/ultra', credits: 8 },
  'stable-image-core': { path: 'stable-image/generate/core', credits: 3 },
  'sd3.5-large': { path: 'stable-image/generate/sd3', model: 'sd3.5-large', credits: 6.5 },
  'sd3.5-large-turbo': { path: 'stable-image/generate/sd3', model: 'sd3.5-large-turbo', credits: 4 },
  'sd3.5-medium': { path: 'stable-image/generate/sd3', model: 'sd3.5-medium', credits: 3.5 },
  'sd3.5-flash': { path: 'stable-image/generate/sd3', model: 'sd3.5-flash', credits: 2.5 },
};

async function form(ctx: AdapterCtx, fields: Record<string, any>) {
  const p = ctx.input.params ?? {};
  const out: Record<string, any> = { ...fields };
  for (const [k, v] of Object.entries(p)) out[k] = typeof v === 'object' ? JSON.stringify(v) : v;
  return multipart(out);
}

export const stabilityAdapter: Adapter = {
  id: 'stability',
  label: 'Stability AI',
  capabilities: ['image', 'audio_music'],
  defaultBase: BASE,
  defaultAuth: 'bearer',
  models: {
    image: [
      { id: 'stable-image-ultra', label: 'Stable Image Ultra (≈ 8 Credits)' },
      { id: 'stable-image-core', label: 'Stable Image Core (≈ 3 Credits)' },
      { id: 'sd3.5-large', label: 'SD 3.5 Large (≈ 6,5 Credits)' },
      { id: 'sd3.5-large-turbo', label: 'SD 3.5 Large Turbo (≈ 4 Credits)' },
      { id: 'sd3.5-medium', label: 'SD 3.5 Medium (≈ 3,5 Credits)' },
    ],
    audio_music: [{ id: 'stable-audio-2.5', label: 'Stable Audio 2.5' }],
  },
  async submit(ctx): Promise<Step> {
    const { headers } = authFor(ctx.conn, 'bearer');
    const base = baseOf(ctx.conn, BASE);
    if (ctx.capability === 'image') {
      const m = IMAGE_MODELS[ctx.model || 'stable-image-core'] ?? { path: 'stable-image/generate/sd3', model: ctx.model, credits: 0 };
      const fields: Record<string, any> = { prompt: ctx.input.prompt, negative_prompt: ctx.input.negative_prompt, output_format: 'png', seed: ctx.input.seed, model: m.model };
      if (ctx.input.image) {
        const img = await ctx.bytes(ctx.input.image, 10 * 1024 * 1024);
        fields.image = { filename: `ref${img.mime === 'image/png' ? '.png' : '.jpg'}`, contentType: img.mime, data: img.data };
        fields.strength = ctx.input.params?.strength ?? 0.6;
        if (m.model) fields.mode = 'image-to-image';
      } else fields.aspect_ratio = ctx.input.aspect_ratio;
      const body = await form(ctx, fields);
      const r = await ctx.fetch(`${base}/v2beta/${m.path}`, { method: 'POST', headers: { ...headers, accept: 'image/*', 'content-type': body.contentType }, body: body.body, timeoutMs: 180_000, maxBytes: 30 * 1024 * 1024 });
      ensureOk(r, 'Stability AI');
      if (/CONTENT_FILTERED/i.test(r.headers['finish-reason'] ?? '')) return { status: 'failed', error: 'Stability AI hat das Bild gefiltert (Inhaltsrichtlinien)' };
      return { status: 'done', outputs: [{ data: r.body }], cost: m.credits ? { amount: m.credits, unit: 'Credits', estimated: true, note: 'laut Preisliste' } : undefined };
    }
    if (ctx.capability === 'audio_music') {
      const body = await form(ctx, { prompt: ctx.input.prompt, duration: ctx.input.duration ?? 30, seed: ctx.input.seed, output_format: 'mp3', model: ctx.model && ctx.model !== 'stable-audio-2.5' ? ctx.model : undefined });
      const r = await ctx.fetch(`${base}/v2beta/audio/stable-audio-2/text-to-audio`, { method: 'POST', headers: { ...headers, accept: 'audio/*', 'content-type': body.contentType }, body: body.body, timeoutMs: 240_000, maxBytes: 60 * 1024 * 1024 });
      ensureOk(r, 'Stability AI');
      return { status: 'done', outputs: [{ data: r.body, mime: 'audio/mpeg' }] };
    }
    throw new ProviderError('Stability AI kann das nicht');
  },
};
