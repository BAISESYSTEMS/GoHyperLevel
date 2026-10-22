import { createHmac, timingSafeEqual } from 'node:crypto';
import { authFor, baseOf, jsonCall, urlsIn } from './http.js';
import { ProviderError, type Adapter, type AdapterCtx, type Step } from './types.js';

/**
 * Replicate – predictions API (https://api.replicate.com/openapi.json), `Authorization: Bearer`:
 * official models: POST /v1/models/{owner}/{name}/predictions {input, webhook};
 * any version: POST /v1/predictions {version: "owner/name:hash" | "hash", input, webhook};
 * GET /v1/predictions/{id} → starting|processing|succeeded|failed|canceled, output, error,
 * metrics.predict_time. Webhooks are signed (webhook-id/-timestamp/-signature, HMAC-SHA256 with the
 * account secret from GET /v1/webhooks/default/secret).
 */

const BASE = 'https://api.replicate.com/v1';

export function replicateInput(ctx: AdapterCtx): Record<string, any> {
  const { input, capability, model } = ctx;
  const out: Record<string, any> = {};
  if (capability === 'audio_tts') {
    out.text = input.prompt;
    if (input.voice) out.voice = input.voice;
  } else if (capability === 'stt') {
    if (input.audio) out.audio = input.audio.url;
    if (input.language) out.language = input.language;
  } else {
    out.prompt = input.prompt;
    if (input.negative_prompt) out.negative_prompt = input.negative_prompt;
    if (input.aspect_ratio) out.aspect_ratio = input.aspect_ratio;
    if (input.seed !== undefined) out.seed = input.seed;
    if (input.duration) out.duration = input.duration;
    if (input.image) {
      const u = input.image.url;
      if (/nano-banana|seedream/.test(model)) out.image_input = [u];
      else if (/kontext/.test(model)) out.input_image = u;
      else if (capability === 'video') out.start_image = u;
      else out.image = u;
    }
  }
  return { ...out, ...(input.params ?? {}) };
}

function outcome(ctx: AdapterCtx, p: any): Step {
  const secs = Number(p?.metrics?.predict_time);
  const cost = Number.isFinite(secs) && secs > 0 ? { note: `${secs.toFixed(1).replace('.', ',')} s Rechenzeit (GPU)` } : undefined;
  if (p.status === 'failed') return { status: 'failed', error: `Replicate: ${String(p.error ?? 'fehlgeschlagen').slice(0, 300)}` };
  if (p.status === 'canceled') return { status: 'failed', error: 'Replicate: abgebrochen' };
  if (p.status !== 'succeeded') return { status: 'pending', state: { id: p.id, get: p.urls?.get }, pollAfterMs: ctx.capability === 'video' ? 8000 : 2500 };
  const o = p.output;
  if (ctx.capability === 'stt') {
    const text = typeof o === 'string' ? o : (o?.transcription ?? o?.text ?? (Array.isArray(o?.segments) ? o.segments.map((s: any) => s.text).join(' ') : undefined));
    return typeof text === 'string' ? { status: 'done', outputs: [], text: text.trim(), cost } : { status: 'failed', error: 'Replicate hat keinen Text geliefert' };
  }
  let all = urlsIn(o);
  if (!all.length && o && typeof o === 'object' && !Array.isArray(o)) all = urlsIn(Object.values(o));
  if (!all.length) return { status: 'failed', error: 'Replicate hat keine Datei geliefert' };
  // Replicate's file URLs may require the token – only its own hosts get it (see trustedHosts).
  return { status: 'done', outputs: all.map((url) => ({ url, auth: true })), cost };
}

const secrets = new Map<string, { at: number; key: string }>();
export const resetReplicateSecrets = () => secrets.clear();

async function signingKey(ctx: AdapterCtx): Promise<string | null> {
  const hit = secrets.get(ctx.conn.connectionId);
  if (hit && Date.now() - hit.at < 3600_000) return hit.key;
  try {
    const { headers } = authFor(ctx.conn, 'bearer');
    const r = await jsonCall(ctx.fetch, 'GET', `${baseOf(ctx.conn, BASE)}/webhooks/default/secret`, headers, undefined, 10_000, 'Replicate');
    const key = String(r?.key ?? '');
    if (!key) return null;
    secrets.set(ctx.conn.connectionId, { at: Date.now(), key });
    return key;
  } catch {
    return null;
  }
}

export function replicateSignature(secret: string, id: string, ts: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
}

const one = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? '') : v === undefined ? '' : String(v));

export const replicateAdapter: Adapter = {
  id: 'replicate',
  label: 'Replicate',
  capabilities: ['image', 'video', 'audio_tts', 'audio_music', 'stt'],
  defaultBase: BASE,
  defaultAuth: 'bearer',
  trustedHosts: () => ['api.replicate.com', 'replicate.delivery', '*.replicate.delivery'],
  models: {
    image: [
      { id: 'black-forest-labs/flux-schnell', label: 'FLUX schnell' },
      { id: 'black-forest-labs/flux-1.1-pro-ultra', label: 'FLUX 1.1 Pro Ultra' },
      { id: 'google/nano-banana', label: 'Nano Banana (Google)' },
      { id: 'ideogram-ai/ideogram-v3-turbo', label: 'Ideogram v3 Turbo (Schrift im Bild)' },
      { id: 'black-forest-labs/flux-kontext-pro', label: 'FLUX Kontext Pro (bearbeiten)', ref: true },
    ],
    video: [
      { id: 'google/veo-3-fast', label: 'Veo 3 Fast' },
      { id: 'kwaivgi/kling-v2.1', label: 'Kling 2.1', ref: true },
      { id: 'minimax/hailuo-02', label: 'MiniMax Hailuo 02' },
      { id: 'wan-video/wan-2.2-t2v-fast', label: 'Wan 2.2 (schnell)' },
    ],
    audio_tts: [
      { id: 'minimax/speech-02-hd', label: 'MiniMax Speech-02 HD' },
      { id: 'jaaari/kokoro-82m', label: 'Kokoro 82M (Version nötig: owner/name:hash)' },
    ],
    audio_music: [
      { id: 'meta/musicgen', label: 'MusicGen (Version nötig: owner/name:hash)' },
      { id: 'minimax/music-01', label: 'MiniMax Music-01' },
    ],
    stt: [{ id: 'openai/whisper', label: 'Whisper (Version nötig: owner/name:hash)' }],
  },
  async submit(ctx) {
    if (!ctx.model) throw new ProviderError('Bitte ein Replicate-Modell angeben, z. B. black-forest-labs/flux-schnell');
    const { headers } = authFor(ctx.conn, 'bearer');
    const base = baseOf(ctx.conn, BASE);
    const body: Record<string, any> = { input: replicateInput(ctx) };
    if (ctx.callbackUrl) Object.assign(body, { webhook: ctx.callbackUrl, webhook_events_filter: ['completed'] });
    const versioned = ctx.model.includes(':') || /^[a-f0-9]{64}$/.test(ctx.model);
    let url: string;
    if (versioned) {
      url = `${base}/predictions`;
      body.version = ctx.model;
    } else {
      const m = /^([\w.-]+)\/([\w.-]+)$/.exec(ctx.model);
      if (!m) throw new ProviderError('Replicate-Modell bitte als owner/name oder owner/name:version angeben');
      url = `${base}/models/${m[1]}/${m[2]}/predictions`;
    }
    const p = await jsonCall(ctx.fetch, 'POST', url, headers, body, 60_000, 'Replicate');
    if (!p?.id) throw new ProviderError('Replicate hat keine Vorhersage-ID geliefert');
    return outcome(ctx, p);
  },
  async poll(ctx, state) {
    const { headers } = authFor(ctx.conn, 'bearer');
    const base = baseOf(ctx.conn, BASE);
    let url = `${base}/predictions/${encodeURIComponent(state.id)}`;
    try {
      if (state.get && new URL(state.get).host === new URL(base).host) url = state.get;
    } catch {
      /* keep the built URL */
    }
    const p = await jsonCall(ctx.fetch, 'GET', url, headers, undefined, 30_000, 'Replicate');
    const step = outcome(ctx, p);
    return step.status === 'pending' ? { ...step, state: { ...state, ...step.state }, pollAfterMs: ctx.capability === 'video' ? 10_000 : 3000 } : step;
  },
  async webhook(ctx, state, req) {
    const id = one(req.headers['webhook-id']);
    const ts = one(req.headers['webhook-timestamp']);
    const sigs = one(req.headers['webhook-signature']);
    if (!id || !ts || !sigs) return null;
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) throw new ProviderError('Signatur abgelaufen', false, 401);
    const secret = await signingKey(ctx);
    if (!secret) return null;
    const expected = Buffer.from(replicateSignature(secret, id, ts, req.rawBody));
    const ok = sigs.split(' ').some((s) => {
      const v = Buffer.from(s.slice(s.indexOf(',') + 1));
      return v.length === expected.length && timingSafeEqual(v, expected);
    });
    if (!ok) throw new ProviderError('Signatur ungültig', false, 401);
    if (state.id && req.body?.id !== state.id) throw new ProviderError('Falscher Auftrag', false, 401);
    const step = outcome(ctx, req.body ?? {});
    return step.status === 'pending' ? null : step;
  },
  async cancel(ctx, state) {
    const { headers } = authFor(ctx.conn, 'bearer');
    await ctx.fetch(`${baseOf(ctx.conn, BASE)}/predictions/${encodeURIComponent(state.id)}/cancel`, { method: 'POST', headers, timeoutMs: 10_000 }).catch(() => undefined);
  },
};
