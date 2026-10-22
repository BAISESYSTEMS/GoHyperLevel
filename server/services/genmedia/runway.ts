import { authFor, baseOf, jsonCall, urlsIn } from './http.js';
import { orientation } from './media.js';
import { ProviderError, type Adapter, type AdapterCtx, type Step } from './types.js';

/**
 * Runway (https://docs.dev.runwayml.com/api.md), `Authorization: Bearer` + `X-Runway-Version`:
 * POST /v1/text_to_image {model, promptText, ratio}, /v1/text_to_video and /v1/image_to_video
 * {model, promptText, promptImage, ratio, duration} → {id}; GET /v1/tasks/{id} → PENDING|THROTTLED|
 * RUNNING|SUCCEEDED|FAILED|CANCELLED with output[] (temporary URLs) or failure.
 */

const BASE = 'https://api.dev.runwayml.com';
const VERSION = '2024-11-06';

const imageRatio = (a?: string) => ({ '16:9': '1920:1080', '9:16': '1080:1920', '4:3': '1440:1080', '3:4': '1080:1440', '21:9': '2112:912' })[String(a)] ?? '1024:1024';
const videoRatio = (a?: string) => (orientation(a) === 'portrait' ? '720:1280' : '1280:720');

function heads(ctx: Pick<AdapterCtx, 'conn'>) {
  const { headers } = authFor(ctx.conn, 'bearer');
  return { ...headers, 'x-runway-version': headers['x-runway-version'] ?? VERSION };
}

export const runwayAdapter: Adapter = {
  id: 'runway',
  label: 'Runway',
  capabilities: ['image', 'video'],
  defaultBase: BASE,
  defaultAuth: 'bearer',
  models: {
    image: [
      { id: 'gen4_image', label: 'Gen-4 Image' },
      { id: 'gen4_image_turbo', label: 'Gen-4 Image Turbo (braucht Referenzbild)', ref: true },
      { id: 'gemini_2.5_flash', label: 'Gemini 2.5 Flash Image' },
    ],
    video: [
      { id: 'gen4.5', label: 'Gen-4.5' },
      { id: 'gen4_turbo', label: 'Gen-4 Turbo (Bild zu Video)', ref: true },
      { id: 'veo3.1', label: 'Veo 3.1' },
      { id: 'veo3.1_fast', label: 'Veo 3.1 Fast' },
    ],
  },
  async submit(ctx): Promise<Step> {
    const b = baseOf(ctx.conn, BASE);
    const p = ctx.input.params ?? {};
    let path: string;
    let body: Record<string, any>;
    if (ctx.capability === 'image') {
      path = '/v1/text_to_image';
      body = { model: ctx.model || 'gen4_image', promptText: ctx.input.prompt, ratio: imageRatio(ctx.input.aspect_ratio), ...(ctx.input.seed !== undefined ? { seed: ctx.input.seed } : {}), ...(ctx.input.image ? { referenceImages: [{ uri: ctx.input.image.url, tag: 'ref' }] } : {}) };
    } else if (ctx.capability === 'video') {
      path = ctx.input.image ? '/v1/image_to_video' : '/v1/text_to_video';
      body = { model: ctx.model || (ctx.input.image ? 'gen4_turbo' : 'gen4.5'), promptText: ctx.input.prompt, ratio: videoRatio(ctx.input.aspect_ratio), duration: ctx.input.duration ?? 5, ...(ctx.input.image ? { promptImage: ctx.input.image.url } : {}), ...(ctx.input.seed !== undefined ? { seed: ctx.input.seed } : {}) };
    } else throw new ProviderError('Runway kann das nicht');
    const r = await jsonCall(ctx.fetch, 'POST', `${b}${path}`, heads(ctx), { ...body, ...p }, 60_000, 'Runway');
    if (!r?.id) throw new ProviderError('Runway hat keine Task-ID geliefert');
    return { status: 'pending', state: { id: String(r.id) }, pollAfterMs: ctx.capability === 'video' ? 10_000 : 4000 };
  },
  async poll(ctx, state): Promise<Step> {
    const t = await jsonCall(ctx.fetch, 'GET', `${baseOf(ctx.conn, BASE)}/v1/tasks/${encodeURIComponent(state.id)}`, heads(ctx), undefined, 30_000, 'Runway');
    if (t.status === 'SUCCEEDED') {
      const urls = urlsIn(t.output);
      return urls.length ? { status: 'done', outputs: urls.map((url) => ({ url })) } : { status: 'failed', error: 'Runway hat keine Datei geliefert' };
    }
    if (t.status === 'FAILED' || t.status === 'CANCELLED') return { status: 'failed', error: `Runway: ${String(t.failure ?? t.failureCode ?? 'fehlgeschlagen').slice(0, 300)}` };
    return { status: 'pending', state, progress: t.progress ? Math.round(Number(t.progress) * 100) : undefined, pollAfterMs: ctx.capability === 'video' ? 12_000 : 5000 };
  },
  async cancel(ctx, state) {
    await ctx.fetch(`${baseOf(ctx.conn, BASE)}/v1/tasks/${encodeURIComponent(state.id)}`, { method: 'DELETE', headers: heads(ctx), timeoutMs: 10_000 }).catch(() => undefined);
  },
};
