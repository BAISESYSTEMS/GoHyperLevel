import { authFor, baseOf, jsonCall, urlsIn } from './http.js';
import { ProviderError, type Adapter, type AdapterCtx, type Step } from './types.js';

/**
 * Luma Dream Machine (https://docs.lumalabs.ai), `Authorization: Bearer`:
 * POST /dream-machine/v1/generations {prompt, model, aspect_ratio, duration, resolution,
 * keyframes.frame0 (image), callback_url} and /generations/image {prompt, model, aspect_ratio,
 * image_ref} → {id, state}; GET /generations/{id} → queued|dreaming|completed|failed, assets.video|image.
 * Callbacks are not signed – they only trigger a poll.
 */

const BASE = 'https://api.lumalabs.ai/dream-machine/v1';
const LUMA_ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9', '9:21'];

function outcome(ctx: AdapterCtx, g: any, state: Record<string, any>): Step {
  if (g.state === 'completed') {
    const url = ctx.capability === 'image' ? g.assets?.image : g.assets?.video;
    const urls = urlsIn(url);
    return urls.length ? { status: 'done', outputs: urls.map((u) => ({ url: u })) } : { status: 'failed', error: 'Luma hat keine Datei geliefert' };
  }
  if (g.state === 'failed') return { status: 'failed', error: `Luma: ${String(g.failure_reason ?? 'fehlgeschlagen').slice(0, 300)}` };
  return { status: 'pending', state, pollAfterMs: ctx.capability === 'video' ? 10_000 : 4000 };
}

export const lumaAdapter: Adapter = {
  id: 'luma',
  label: 'Luma Dream Machine',
  capabilities: ['image', 'video'],
  defaultBase: BASE,
  defaultAuth: 'bearer',
  models: {
    image: [
      { id: 'photon-1', label: 'Photon' },
      { id: 'photon-flash-1', label: 'Photon Flash (günstig)' },
    ],
    video: [
      { id: 'ray-2', label: 'Ray 2' },
      { id: 'ray-flash-2', label: 'Ray 2 Flash' },
    ],
  },
  async submit(ctx): Promise<Step> {
    const { headers } = authFor(ctx.conn, 'bearer');
    const b = baseOf(ctx.conn, BASE);
    const p = ctx.input.params ?? {};
    const aspect = LUMA_ASPECTS.includes(String(ctx.input.aspect_ratio)) ? ctx.input.aspect_ratio : undefined;
    let url: string;
    let body: Record<string, any>;
    if (ctx.capability === 'image') {
      url = `${b}/generations/image`;
      body = { prompt: ctx.input.prompt, model: ctx.model || 'photon-1', ...(aspect ? { aspect_ratio: aspect } : {}), ...(ctx.input.image ? { image_ref: [{ url: ctx.input.image.url, weight: 0.85 }] } : {}) };
    } else if (ctx.capability === 'video') {
      url = `${b}/generations`;
      body = { prompt: ctx.input.prompt, model: ctx.model || 'ray-2', ...(aspect ? { aspect_ratio: aspect } : {}), duration: (ctx.input.duration ?? 5) > 5 ? '9s' : '5s', resolution: '720p', ...(ctx.input.image ? { keyframes: { frame0: { type: 'image', url: ctx.input.image.url } } } : {}) };
    } else throw new ProviderError('Luma kann das nicht');
    if (ctx.callbackUrl) body.callback_url = ctx.callbackUrl;
    const g = await jsonCall(ctx.fetch, 'POST', url, headers, { ...body, ...p }, 60_000, 'Luma');
    if (!g?.id) throw new ProviderError('Luma hat keine Generierungs-ID geliefert');
    return outcome(ctx, g, { id: String(g.id) });
  },
  async poll(ctx, state): Promise<Step> {
    const { headers } = authFor(ctx.conn, 'bearer');
    const g = await jsonCall(ctx.fetch, 'GET', `${baseOf(ctx.conn, BASE)}/generations/${encodeURIComponent(state.id)}`, headers, undefined, 30_000, 'Luma');
    return outcome(ctx, g, state);
  },
};
