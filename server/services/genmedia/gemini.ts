import { authFor, baseOf, jsonCall } from './http.js';
import { MAX_INPUT_BYTES, pcmToWav } from './media.js';
import { ProviderError, type Adapter, type AdapterCtx, type Output, type Step } from './types.js';

/**
 * Google Gemini API (https://ai.google.dev/gemini-api/docs), header `x-goog-api-key`:
 * - images (Nano Banana): POST /v1beta/models/{model}:generateContent with responseModalities
 *   [TEXT, IMAGE] → candidates[0].content.parts[].inlineData; legacy Imagen: :predict
 * - video (Veo): POST /v1beta/models/{model}:predictLongRunning {instances, parameters} → {name};
 *   GET /v1beta/{name} until done → response.generateVideoResponse.generatedSamples[].video.uri
 *   (download with the key)
 * - speech (TTS models), music (Lyria) and transcription: generateContent with inline audio
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_VOICES = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'];

/** The registry may hand out the OpenAI-compatible base (…/v1beta/openai) – the native API lives one level up. */
function base(ctx: Pick<AdapterCtx, 'conn'>): string {
  const b = baseOf(ctx.conn, BASE).replace(/\/openai$/, '');
  return /generativelanguage\.googleapis\.com$/.test(b) ? `${b}/v1beta` : b;
}

const call = (ctx: AdapterCtx, path: string, body: unknown, timeoutMs = 180_000) => {
  const { headers } = authFor(ctx.conn, 'header:x-goog-api-key');
  return jsonCall(ctx.fetch, 'POST', `${base(ctx)}/${path}`, headers, body, timeoutMs, 'Gemini');
};

/** inlineData parts of a generateContent answer. */
function inlineParts(r: any): { mime: string; data: Buffer }[] {
  const out: { mime: string; data: Buffer }[] = [];
  for (const c of r?.candidates ?? []) for (const p of c?.content?.parts ?? []) {
    const d = p.inlineData ?? p.inline_data;
    if (d?.data) out.push({ mime: String(d.mimeType ?? d.mime_type ?? ''), data: Buffer.from(d.data, 'base64') });
  }
  return out;
}
function textOf(r: any): string {
  return (r?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('').trim();
}
function blocked(r: any): string | null {
  const reason = r?.promptFeedback?.blockReason ?? (r?.candidates?.[0]?.finishReason && !['STOP', 'MAX_TOKENS'].includes(r.candidates[0].finishReason) ? r.candidates[0].finishReason : null);
  return reason ? `Gemini hat die Anfrage abgelehnt (${reason})` : null;
}

/** Gemini TTS sends raw PCM (audio/L16;codec=pcm;rate=24000) – wrap it so players understand it. */
function audioOutput(p: { mime: string; data: Buffer }): Output {
  if (/l16|pcm/i.test(p.mime)) {
    const rate = Number(/rate=(\d+)/i.exec(p.mime)?.[1]) || 24000;
    return { data: pcmToWav(p.data, rate), mime: 'audio/wav' };
  }
  return { data: p.data, mime: p.mime };
}

async function inlineRef(ctx: AdapterCtx, ref: NonNullable<AdapterCtx['input']['image']>) {
  const f = await ctx.bytes(ref, MAX_INPUT_BYTES);
  return { mimeType: f.mime, data: f.data.toString('base64') };
}

export const geminiAdapter: Adapter = {
  id: 'gemini',
  label: 'Google Gemini',
  capabilities: ['image', 'video', 'audio_tts', 'audio_music', 'stt'],
  defaultBase: BASE,
  defaultAuth: 'header:x-goog-api-key',
  trustedHosts: (b) => [new URL(b).hostname],
  models: {
    image: [
      { id: 'gemini-2.5-flash-image', label: 'Nano Banana (Gemini 2.5 Flash Image)' },
      { id: 'gemini-3.1-flash-image', label: 'Nano Banana 2 (Gemini 3.1 Flash Image)' },
      { id: 'gemini-3-pro-image-preview', label: 'Nano Banana Pro' },
    ],
    video: [
      { id: 'veo-3.1-generate-preview', label: 'Veo 3.1' },
      { id: 'veo-3.1-fast-generate-preview', label: 'Veo 3.1 Fast' },
      { id: 'veo-3.1-lite-generate-preview', label: 'Veo 3.1 Lite' },
      { id: 'veo-3.0-generate-001', label: 'Veo 3' },
    ],
    audio_tts: [
      { id: 'gemini-2.5-flash-preview-tts', label: 'Gemini 2.5 Flash TTS' },
      { id: 'gemini-2.5-pro-preview-tts', label: 'Gemini 2.5 Pro TTS' },
      { id: 'gemini-3.1-flash-tts-preview', label: 'Gemini 3.1 Flash TTS' },
    ],
    audio_music: [
      { id: 'lyria-3-clip-preview', label: 'Lyria 3 Clip' },
      { id: 'lyria-3.5', label: 'Lyria 3.5' },
    ],
    stt: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Transkription)' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (Transkription)' },
    ],
  },
  voices: async () => GEMINI_VOICES.map((v) => ({ id: v, name: v })),
  async submit(ctx): Promise<Step> {
    const p = ctx.input.params ?? {};
    const model = ctx.model.replace(/^models\//, '');
    if (!model) throw new ProviderError('Bitte ein Gemini-Modell angeben');
    if (ctx.capability === 'image') {
      if (/^imagen/.test(model)) {
        const r = await call(ctx, `models/${model}:predict`, { instances: [{ prompt: ctx.input.prompt }], parameters: { sampleCount: 1, ...(ctx.input.aspect_ratio ? { aspectRatio: ctx.input.aspect_ratio } : {}), ...p } });
        const outputs = ((r.predictions ?? []) as any[]).filter((x) => x.bytesBase64Encoded).map((x) => ({ data: Buffer.from(x.bytesBase64Encoded, 'base64'), mime: x.mimeType }));
        if (!outputs.length) throw new ProviderError('Gemini (Imagen) hat kein Bild geliefert');
        return { status: 'done', outputs };
      }
      const parts: any[] = [{ text: ctx.input.prompt }];
      if (ctx.input.image) parts.push({ inline_data: await inlineRef(ctx, ctx.input.image).then((d) => ({ mime_type: d.mimeType, data: d.data })) });
      const generationConfig: Record<string, any> = { responseModalities: ['TEXT', 'IMAGE'], ...(ctx.input.aspect_ratio ? { imageConfig: { aspectRatio: ctx.input.aspect_ratio } } : {}) };
      const r = await call(ctx, `models/${model}:generateContent`, { contents: [{ parts }], generationConfig: { ...generationConfig, ...(p.generationConfig ?? {}) }, ...omit(p, 'generationConfig') });
      const imgs = inlineParts(r).filter((x) => x.mime.startsWith('image/'));
      if (!imgs.length) throw new ProviderError(blocked(r) ?? 'Gemini hat kein Bild geliefert');
      return { status: 'done', outputs: imgs.map((x) => ({ data: x.data, mime: x.mime })), cost: usage(r) };
    }
    if (ctx.capability === 'video') {
      const instance: Record<string, any> = { prompt: ctx.input.prompt };
      if (ctx.input.image) instance.image = { inlineData: await inlineRef(ctx, ctx.input.image) };
      const parameters: Record<string, any> = {};
      if (ctx.input.aspect_ratio) parameters.aspectRatio = ctx.input.aspect_ratio;
      if (ctx.input.negative_prompt) parameters.negativePrompt = ctx.input.negative_prompt;
      if (ctx.input.duration) parameters.durationSeconds = ctx.input.duration;
      if (ctx.input.seed !== undefined) parameters.seed = ctx.input.seed;
      const r = await call(ctx, `models/${model}:predictLongRunning`, { instances: [{ ...instance, ...(p.instance ?? {}) }], parameters: { ...parameters, ...omit(p, 'instance') } }, 60_000);
      if (!r?.name) throw new ProviderError('Gemini hat keine Operation geliefert');
      return { status: 'pending', state: { name: String(r.name) }, pollAfterMs: 10_000 };
    }
    if (ctx.capability === 'audio_tts') {
      const speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: ctx.input.voice || 'Kore' } } };
      const r = await call(ctx, `models/${model}:generateContent`, { contents: [{ parts: [{ text: ctx.input.prompt }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig, ...(p.generationConfig ?? {}) } });
      const a = inlineParts(r).filter((x) => /audio|pcm|l16/i.test(x.mime));
      if (!a.length) throw new ProviderError(blocked(r) ?? 'Gemini hat keine Sprachausgabe geliefert');
      return { status: 'done', outputs: a.map(audioOutput) };
    }
    if (ctx.capability === 'audio_music') {
      const r = await call(ctx, `models/${model}:generateContent`, { contents: [{ parts: [{ text: ctx.input.prompt }] }], ...p });
      const a = inlineParts(r).filter((x) => /audio|pcm|l16/i.test(x.mime));
      if (!a.length) throw new ProviderError(blocked(r) ?? 'Gemini (Lyria) hat keine Musik geliefert');
      return { status: 'done', outputs: a.map(audioOutput) };
    }
    if (ctx.capability === 'stt') {
      if (!ctx.input.audio) throw new ProviderError('Bitte eine Audio- oder Videodatei angeben');
      const audio = await inlineRef(ctx, ctx.input.audio);
      const ask = `Transkribiere diese Aufnahme wortgetreu${ctx.input.language ? ` (Sprache: ${ctx.input.language})` : ''}. Gib nur den Text zurück.${ctx.input.prompt ? ` Hinweis: ${ctx.input.prompt}` : ''}`;
      const r = await call(ctx, `models/${model}:generateContent`, { contents: [{ parts: [{ text: ask }, { inline_data: { mime_type: audio.mimeType, data: audio.data } }] }], ...p });
      const text = textOf(r);
      if (!text) throw new ProviderError(blocked(r) ?? 'Gemini hat keinen Text geliefert');
      return { status: 'done', outputs: [], text, cost: usage(r) };
    }
    throw new ProviderError('Gemini kann das nicht');
  },
  async poll(ctx, state): Promise<Step> {
    const { headers } = authFor(ctx.conn, 'header:x-goog-api-key');
    const name = String(state.name).replace(/^\/+/, '');
    if (!/^[\w./-]+$/.test(name) || name.includes('..')) throw new ProviderError('Ungültige Operation');
    const op = await jsonCall(ctx.fetch, 'GET', `${base(ctx)}/${name}`, headers, undefined, 30_000, 'Gemini');
    if (!op.done) return { status: 'pending', state, pollAfterMs: 12_000 };
    if (op.error) return { status: 'failed', error: `Gemini: ${String(op.error.message ?? 'Fehler').slice(0, 300)}` };
    const res = op.response ?? {};
    const samples = res.generateVideoResponse?.generatedSamples ?? res.generatedVideos ?? res.videos ?? [];
    const outputs: Output[] = [];
    for (const s of samples) {
      const v = s.video ?? s;
      if (v.uri) outputs.push({ url: String(v.uri), auth: true });
      else if (v.bytesBase64Encoded || v.videoBytes) outputs.push({ data: Buffer.from(v.bytesBase64Encoded ?? v.videoBytes, 'base64'), mime: v.mimeType ?? 'video/mp4' });
    }
    if (!outputs.length) {
      const filtered = res.generateVideoResponse?.raiMediaFilteredReasons?.[0];
      return { status: 'failed', error: filtered ? `Gemini hat das Video gefiltert: ${filtered}` : 'Gemini hat kein Video geliefert' };
    }
    return { status: 'done', outputs };
  },
};

function omit(o: Record<string, any>, key: string) {
  const { [key]: _drop, ...rest } = o;
  return rest;
}

function usage(r: any) {
  const n = Number(r?.usageMetadata?.totalTokenCount);
  return Number.isFinite(n) && n > 0 ? { amount: n, unit: 'Tokens' } : undefined;
}
