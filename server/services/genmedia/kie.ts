import { createHmac, timingSafeEqual } from 'node:crypto';
import { authFor, baseOf, deepMediaUrls, jsonCall, urlsIn } from './http.js';
import { ProviderError, type Adapter, type AdapterCtx, type Output, type Step, type VoiceEntry } from './types.js';

/**
 * kie.ai – async tasks with `Authorization: Bearer <key>` (https://docs.kie.ai):
 * - Market API (current docs, every model): POST /api/v1/jobs/createTask {model, callBackUrl, input}
 *   → {code, data: {taskId}}; GET /api/v1/jobs/recordInfo?taskId= → state waiting|queuing|generating|
 *   success|fail, resultJson = '{"resultUrls": […]}', creditsConsumed.
 * - Dedicated endpoints of the popular models (the older per-model API, still served): Veo 3, Runway,
 *   GPT-4o image, Flux Kontext, Midjourney, Suno – each with its own record-info path.
 * - Generic task: the user gives endpoint path + JSON body (and optionally the record path).
 * Callbacks are only trusted after asking kie for the record (or with a webhook HMAC key).
 */

const BASE = 'https://api.kie.ai';
const MARKET_CREATE = '/api/v1/jobs/createTask';
const MARKET_RECORD = '/api/v1/jobs/recordInfo';

/**
 * Speech (ElevenLabs through kie's Market API): `elevenlabs/text-to-speech-turbo-2-5` or `…-multilingual-v2`, input
 * {text, voice, stability, similarity_boost, style, speed 0.7–1.2, language_code (Turbo/Flash only – the others reject it)}.
 * `voice` is one of kie's own voice ids (KIE_VOICES, docs.kie.ai, October 2026); previews at
 * https://static.aiquickdraw.com/elevenlabs/voice/<id>.mp3. The result is an audio URL in resultJson.resultUrls.
 */
export const KIE_TTS_DEFAULT = 'elevenlabs/text-to-speech-turbo-2-5';
/** Jarvis on kie.ai: "Brian – Deep, Resonant and Comforting", a calm male voice; Turbo 2.5 with language_code speaks the app's language. */
export const KIE_JARVIS_VOICE = 'nPczCjzI2devNBz1zQrb';
const KIE_TTS_POLL_MS = 800;
export const KIE_VOICES: VoiceEntry[] = (
  [
    ['nPczCjzI2devNBz1zQrb', 'Brian – Deep, Resonant and Comforting'],
    ['EkK5I93UQWFDigLMpZcX', 'James – Husky, Engaging and Bold'],
    ['MJ0RnG71ty4LH3dvNfSd', 'Leon – Soothing and Grounded'],
    ['LruHrtVF6PSyGItzMNHS', 'Benjamin – Deep, Warm, Calming'],
    ['hqfrgApggtO1785R4Fsn', 'Theodore HQ – Serene and Grounded'],
    ['8JVbfL6oEdmuxKn5DK2C', 'Johnny Kid – Serious and Calm Narrator'],
    ['6F5Zhi321D3Oq7v1oNT4', 'Hank – Deep and Engaging Narrator'],
    ['gs0tAILXbY5DNrJrsM6F', 'Jeff – Classy, Resonating and Strong'],
    ['NNl6r8mD7vthiJatiJt1', 'Bradford – Expressive and Articulate'],
    ['UgBBYS2sOqTuMpoF3BR0', 'Mark – Natural Conversations'],
    ['1SM7GgM6IMuvQlz2BwM3', 'Mark – Casual, Relaxed and Light'],
    ['DYkrAHD8iwork3YSUBbs', 'Tom – Conversations & Books'],
    ['x70vRnQBMBu4FAYhjJbO', 'Nathan – Virtual Radio Host'],
    ['AeRdCCKzvd23BpJoofzx', 'Nathaniel – Engaging, British and Calm'],
    ['Sq93GQT4X1lKDXsQcixO', 'Felix – Warm, Positive & Contemporary RP'],
    ['Tsns2HvNFKfGiNjllgqo', 'Sven – Emotional and Nice'],
    ['vBKc2FfBKJfcZNyEt1n6', 'Finn – Youthful, Eager and Energetic'],
    ['TX3LPaxmHKxFdv7VOQHJ', 'Liam – Energetic, Social Media Creator'],
    ['N2lVS1w4EtoT3dr4eOWO', 'Callum – Husky Trickster'],
    ['scOwDtmlUjD3prqpp97I', 'Sam – Support Agent'],
    ['NOpBlnGInO9m6vDvFkFC', 'Spuds Oxley – Wise and Approachable'],
    ['qDuRKMlYmrm8trt5QyBn', 'Taksh – Calm, Serious and Smooth'],
    ['P1bg08DkjqiVEzOn76yG', 'Viraj – Rich and Soft'],
    ['1U02n4nD6AdIZ9CjF053', 'Viraj – Smooth and Gentle'],
    ['DTKMou8ccj1ZaWGBiotd', 'Jamahal – Young, Vibrant, and Natural'],
    ['EiNlNiXeDU1pqqOPrYMO', 'John Doe – Deep'],
    ['4YYIPFl9wE5c4L2eu2Gb', 'Burt Reynolds™ – Deep, Smooth and Clear'],
    ['mtrellq69YZsNwzUSyXh', 'Rex Thunder – Deep N Tough'],
    ['dHd5gvgSOzSfduK4CvEg', 'Ed – Late Night Announcer'],
    ['zYcjlYFOd3taleS0gkk3', 'Edward – Loud, Confident and Cocky'],
    ['nzeAacJi50IvxcyDnMXa', 'Marshal – Friendly, Funny Professor'],
    ['9yzdeviXkFddZ4Oz8Mok', 'Lutz – Chuckling, Giggly and Cheerful'],
    ['YOq2y2Up4RgXP2HyXjE5', 'Xavier – Dominating, Metallic Announcer'],
    ['DGzg6RaUqxGRTHSBjfgF', 'Brock – Commanding and Loud Sergeant'],
    ['qXpMhyvQqiRxWQs4qSSB', 'Horatius – Energetic Character Voice'],
    ['ruirxsoakN0GWmGNIo04', 'John Morgan – Gritty, Rugged Cowboy'],
    ['YXpFCvM1S3JbWEJhoskW', 'Wyatt – Wise Rustic Cowboy'],
    ['LG95yZDEHg6fCZdQjLqj', 'Phil – Explosive, Passionate Announcer'],
    ['CeNX9CMwmxDxUF5Q2Inm', 'Johnny Dynamite – Vintage Radio DJ'],
    ['ljo9gAlSqKOvF6D8sOsX', 'Viking Bjorn – Epic Medieval Raider'],
    ['PPzYpIqttlTYA83688JI', 'Pirate Marshal'],
    ['wo6udizrrtpIxWGp2qJk', 'Northern Terry'],
    ['gU0LNdkMOQCOrPrwtbee', 'British Football Announcer'],
    ['B8gJV1IhpuegLxdpXFOE', 'Kuon – Cheerful, Clear and Steady'],
    ['hpp4J3VqNfWAUOO0d1Us', 'Bella – Professional, Bright, Warm'],
    ['2zRM7PkgwBPiau2jvVXc', 'Monika Sogam – Deep and Natural'],
    ['5l5f8iK3YPeGga21rQIX', 'Adeline – Feminine and Conversational'],
    ['Z3R5wn05IrDiVCyEkUrK', 'Arabella – Mysterious and Emotive'],
    ['BZgkqPqms7Kj9ulSkVzn', 'Eve – Authentic, Energetic and Happy'],
    ['Sm1seazb4gs7RSlUVw7c', 'Anika – Animated, Friendly and Engaging'],
    ['FGY2WhTYpPnrIDTdsKH5', 'Laura – Enthusiast, Quirky Attitude'],
    ['kPzsL2i3teMYv0FxEYQ6', 'Brittney – Social Media Voice'],
    ['uYXf8XasLslADfZ2MB4u', 'Hope – Bubbly, Gossipy and Girly'],
    ['iCrDUkL56s3C8sCRl7wb', 'Hope – Poetic, Romantic and Captivating'],
    ['56AoDkrOh6qfVPDXZ7Pt', 'Cassidy – Crisp, Direct and Clear'],
    ['eR40ATw9ArzDf9h3v7t7', 'Addison 2.0 – Australian Audiobook & Podcast'],
    ['g6xIsTj2HwM6VR4iXFCw', 'Jessica Anne Bogart – Chatty and Friendly'],
    ['flHkNRp1BlvT73UL6gyz', 'Jessica Anne Bogart – Eloquent Villain'],
    ['lcMyyd2HUfFzxdCaC4Ta', 'Lucy – Fresh & Casual'],
    ['6aDn1KB0hjpdcocrUkmq', 'Tiffany – Natural and Welcoming'],
    ['pPdl9cQBQq4p6mRkZy2Z', 'Emma – Adorable and Upbeat'],
    ['TC0Zp7WVFzhA8zpTlRqV', 'Aria – Sultry Villain'],
    ['wJqPPQ618aTW29mptyoc', 'Ana Rita – Smooth, Expressive and Bright'],
    ['aD6riP1btT197c6dACmy', 'Rachel M – Pro British Radio Presenter'],
    ['eVItLK1UvXctxuaRV2Oq', 'Jean – Alluring and Playful Femme Fatale'],
    ['esy0r39YPLQjOczyOib8', 'Britney – Calm and Calculative Villain'],
    ['1wGbFxmAM3Fgw63G1zZJ', 'Allison – Calm, Soothing and Meditative'],
  ] as const
).map(([id, name]) => ({ id, name, preview: `https://static.aiquickdraw.com/elevenlabs/voice/${id}.mp3` }));
const KIE_VOICE_IDS = new Set(KIE_VOICES.map((v) => v.id));
/** ElevenLabs-style voice id (20 letters/digits) – kie may know more voices than its docs list; anything else ('auto', "de-DE-…") is no kie voice. */
const ELEVEN_ID = /^[A-Za-z0-9]{20}$/;
/** The voice to send: a kie/ElevenLabs id stays, everything else (the app's "auto", a Google voice name) becomes the Jarvis voice. */
export const kieVoice = (voice?: string): string => (voice && (KIE_VOICE_IDS.has(voice) || ELEVEN_ID.test(voice)) ? voice : KIE_JARVIS_VOICE);

interface Legacy {
  create: string;
  record: string;
  body: (ctx: AdapterCtx) => Record<string, any>;
}

const aspect = (ctx: AdapterCtx, def: string) => ctx.input.aspect_ratio || def;

/** Models with their own (older) endpoints – keyed by the model id the user picks. */
export const KIE_LEGACY: Record<string, Legacy> = {
  veo3: { create: '/api/v1/veo/generate', record: '/api/v1/veo/record-info', body: (c) => ({ prompt: c.input.prompt, model: 'veo3', aspectRatio: aspect(c, '16:9'), ...(c.input.image ? { imageUrls: [c.input.image.url] } : {}), ...(c.input.seed !== undefined ? { seeds: c.input.seed } : {}) }) },
  veo3_fast: { create: '/api/v1/veo/generate', record: '/api/v1/veo/record-info', body: (c) => ({ prompt: c.input.prompt, model: 'veo3_fast', aspectRatio: aspect(c, '16:9'), ...(c.input.image ? { imageUrls: [c.input.image.url] } : {}), ...(c.input.seed !== undefined ? { seeds: c.input.seed } : {}) }) },
  'runway-gen3': { create: '/api/v1/runway/generate', record: '/api/v1/runway/record-detail', body: (c) => ({ prompt: c.input.prompt, duration: c.input.duration && c.input.duration > 5 ? 10 : 5, quality: '720p', aspectRatio: aspect(c, '16:9'), ...(c.input.image ? { imageUrl: c.input.image.url } : {}), waterMark: '' }) },
  'gpt4o-image': { create: '/api/v1/gpt4o-image/generate', record: '/api/v1/gpt4o-image/record-info', body: (c) => ({ prompt: c.input.prompt, size: ['1:1', '3:2', '2:3'].includes(String(c.input.aspect_ratio)) ? c.input.aspect_ratio : '1:1', nVariants: 1, ...(c.input.image ? { filesUrl: [c.input.image.url] } : {}) }) },
  'flux-kontext-pro': { create: '/api/v1/flux/kontext/generate', record: '/api/v1/flux/kontext/record-info', body: (c) => ({ prompt: c.input.prompt, model: 'flux-kontext-pro', aspectRatio: aspect(c, '16:9'), outputFormat: 'png', ...(c.input.image ? { inputImage: c.input.image.url } : {}) }) },
  'flux-kontext-max': { create: '/api/v1/flux/kontext/generate', record: '/api/v1/flux/kontext/record-info', body: (c) => ({ prompt: c.input.prompt, model: 'flux-kontext-max', aspectRatio: aspect(c, '16:9'), outputFormat: 'png', ...(c.input.image ? { inputImage: c.input.image.url } : {}) }) },
  midjourney: { create: '/api/v1/mj/generate', record: '/api/v1/mj/record-info', body: (c) => ({ taskType: c.input.image ? 'mj_img2img' : 'mj_txt2img', prompt: c.input.prompt, aspectRatio: aspect(c, '1:1'), speed: 'fast', version: '7', ...(c.input.image ? { fileUrls: [c.input.image.url] } : {}) }) },
  'suno-V4_5': { create: '/api/v1/generate', record: '/api/v1/generate/record-info', body: (c) => ({ prompt: c.input.prompt, customMode: false, instrumental: false, model: 'V4_5' }) },
  'suno-V5': { create: '/api/v1/generate', record: '/api/v1/generate/record-info', body: (c) => ({ prompt: c.input.prompt, customMode: false, instrumental: false, model: 'V5' }) },
};

/** `input` of a Market task from the generic fields (raw parameters win). */
export function kieMarketInput(ctx: AdapterCtx): Record<string, any> {
  const { input, capability, model } = ctx;
  const out: Record<string, any> = {};
  if (capability === 'audio_tts') {
    out.text = input.prompt;
    out.voice = kieVoice(input.voice);
    if (input.speed && input.speed !== 1) out.speed = Math.max(0.7, Math.min(1.2, input.speed));
    // only Turbo/Flash take a language (it keeps German text from being read with an English accent); the others reject it
    const lang = String(input.language ?? '').trim().toLowerCase().split(/[-_]/)[0];
    if (/turbo|flash/.test(model) && /^[a-z]{2}$/.test(lang)) out.language_code = lang;
  } else if (capability === 'stt') {
    if (input.audio) out.audio_url = input.audio.url;
    if (input.language) out.language_code = input.language;
  } else if (model === 'ai-music-api/generate') {
    Object.assign(out, { prompt: input.prompt, custom_mode: false, instrumental: false, model: 'V4_5' });
  } else {
    out.prompt = input.prompt;
    if (input.negative_prompt) out.negative_prompt = input.negative_prompt;
    if (input.aspect_ratio) out[model === '4o-image-api' ? 'size' : 'aspect_ratio'] = input.aspect_ratio;
    if (input.duration) out.duration = /kling|runway|hailuo|bytedance|wan/.test(model) ? String(input.duration) : input.duration;
    if (input.seed !== undefined) out.seed = input.seed;
    if (input.image) {
      const u = input.image.url;
      if (model === 'flux1-kontext') out.input_image = u;
      else if (model === 'runway' || /image-to-video|i2v/.test(model)) out.image_url = u;
      else if (model === '4o-image-api') out.files_url = [u];
      else out.image_urls = [u];
    }
  }
  return { ...out, ...(input.params ?? {}) };
}

const parseJson = (v: any) => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

/** Media URLs of a kie record (Market or the older per-model answers). */
export function kieUrls(d: any): string[] {
  const urls: string[] = [];
  const rj = parseJson(d?.resultJson);
  if (rj) urls.push(...urlsIn(rj.resultUrls), ...urlsIn(rj.resultUrl));
  const resp = d?.response;
  if (resp) {
    urls.push(...urlsIn(resp.resultUrls), ...urlsIn(resp.resultImageUrl));
    if (Array.isArray(resp.sunoData)) for (const s of resp.sunoData) urls.push(...urlsIn(s.audioUrl ?? s.audio_url));
  }
  urls.push(...urlsIn(d?.videoInfo?.videoUrl), ...urlsIn(d?.info?.resultUrls));
  const mj = parseJson(d?.resultInfoJson);
  if (mj?.resultUrls) urls.push(...urlsIn((mj.resultUrls as any[]).map((x) => x?.resultUrl ?? x)));
  const uniq = [...new Set(urls)];
  return uniq.length ? uniq : deepMediaUrls(d);
}

/** Interprets one record: pending, done or failed. */
export function kieRecord(ctx: AdapterCtx, d: any): Step {
  if (!d || typeof d !== 'object') return { status: 'pending', state: {}, pollAfterMs: 5000 };
  const credits = Number(d.creditsConsumed);
  const cost = Number.isFinite(credits) && credits > 0 ? { amount: credits, unit: 'Credits' } : undefined;
  const fail = (msg: unknown) => ({ status: 'failed' as const, error: `kie.ai: ${String(msg || 'Erzeugung fehlgeschlagen').slice(0, 300)}` });
  const done = (): Step => {
    if (ctx.capability === 'stt') {
      const rj = parseJson(d.resultJson);
      const text = rj?.resultObject?.text ?? rj?.text ?? rj?.resultObject?.transcript;
      return typeof text === 'string' ? { status: 'done', outputs: [], text, cost } : fail('kein Text im Ergebnis');
    }
    const outputs: Output[] = kieUrls(d).map((url) => ({ url }));
    return outputs.length ? { status: 'done', outputs, cost } : fail('keine Datei im Ergebnis');
  };
  if (typeof d.state === 'string') {
    const st = d.state.toLowerCase();
    if (st === 'success') return done();
    if (st === 'fail' || st === 'failed') return fail(d.failMsg || d.failCode || d.errorMessage);
    return { status: 'pending', state: {}, progress: Number(d.progress) || undefined };
  }
  if (d.successFlag !== undefined && d.successFlag !== null) {
    const f = Number(d.successFlag);
    if (f === 1) return done();
    if (f >= 2) return fail(d.errorMessage || d.errorCode);
    return { status: 'pending', state: {} };
  }
  if (typeof d.status === 'string') {
    const st = d.status.toUpperCase();
    if (st === 'SUCCESS' || st === 'COMPLETED') return done();
    if (/FAIL|ERROR/.test(st)) return fail(d.errorMessage || d.status);
    return { status: 'pending', state: {} };
  }
  return { status: 'pending', state: {} };
}

/** kie wraps everything in {code, msg, data}; code 200 = ok. */
function unwrap(r: any, what: string): any {
  const code = Number(r?.code ?? 200);
  if (code !== 200) throw new ProviderError(`kie.ai (${what}): ${String(r?.msg ?? 'Fehler').slice(0, 300)} (Code ${code})${code === 402 ? ' – Guthaben aufladen' : code === 401 ? ' – Schlüssel prüfen' : ''}`, code === 429 || code >= 500, code);
  return r?.data;
}

function recordPath(create: string, poll?: string): string {
  if (poll) return poll;
  if (create === MARKET_CREATE) return MARKET_RECORD;
  return create.replace(/\/generate$/, '/record-info');
}

const safePath = (p: unknown, what: string) => {
  const s = String(p ?? '').trim();
  if (!/^\/api\/[\w./-]{1,200}$/.test(s) || s.includes('..')) throw new ProviderError(`${what}: bitte einen Pfad wie /api/v1/… angeben`);
  return s;
};

export const kieAdapter: Adapter = {
  id: 'kie',
  label: 'kie.ai',
  capabilities: ['image', 'video', 'audio_tts', 'audio_music', 'stt'],
  defaultBase: BASE,
  defaultAuth: 'bearer',
  models: {
    image: [
      { id: 'google/nano-banana', label: 'Nano Banana (Google)' },
      { id: 'google/nano-banana-edit', label: 'Nano Banana Edit', ref: true },
      { id: 'google/imagen4', label: 'Imagen 4' },
      { id: 'grok-imagine/text-to-image', label: 'Grok Imagine' },
      { id: 'flux1-kontext', label: 'Flux Kontext' },
      { id: '4o-image-api', label: 'GPT-4o Image' },
      { id: 'flux-kontext-pro', label: 'Flux Kontext Pro (eigener Endpunkt)' },
      { id: 'gpt4o-image', label: 'GPT-4o Image (eigener Endpunkt)' },
      { id: 'midjourney', label: 'Midjourney (eigener Endpunkt)' },
    ],
    video: [
      { id: 'veo-3-1', label: 'Veo 3.1' },
      { id: 'runway', label: 'Runway' },
      { id: 'kling-2.6/text-to-video', label: 'Kling 2.6' },
      { id: 'kling-2.6/image-to-video', label: 'Kling 2.6 – Bild zu Video', ref: true },
      { id: 'grok-imagine/text-to-video', label: 'Grok Imagine Video' },
      { id: 'bytedance/v1-pro-text-to-video', label: 'Seedance V1 Pro' },
      { id: 'veo3_fast', label: 'Veo 3 Fast (eigener Endpunkt)' },
      { id: 'runway-gen3', label: 'Runway (eigener Endpunkt)' },
    ],
    audio_tts: [
      { id: 'elevenlabs/text-to-speech-multilingual-v2', label: 'ElevenLabs Multilingual v2' },
      { id: 'elevenlabs/text-to-speech-turbo-2-5', label: 'ElevenLabs Turbo 2.5' },
    ],
    audio_music: [
      { id: 'ai-music-api/generate', label: 'Suno (Musik)' },
      { id: 'suno-V4_5', label: 'Suno V4.5 (eigener Endpunkt)' },
    ],
    stt: [{ id: 'elevenlabs/speech-to-text', label: 'ElevenLabs Speech-to-Text' }],
  },
  async submit(ctx) {
    const { headers } = authFor(ctx.conn, 'bearer');
    const base = baseOf(ctx.conn, BASE);
    let create: string;
    let body: Record<string, any>;
    let poll: string | undefined;
    if (ctx.input.kie_task) {
      create = safePath(ctx.input.kie_task.endpoint, 'Kie-Task-Endpunkt');
      body = { ...(ctx.input.kie_task.body ?? {}) };
      poll = ctx.input.kie_task.poll_path ? safePath(ctx.input.kie_task.poll_path, 'Abfrage-Pfad') : undefined;
    } else if (KIE_LEGACY[ctx.model]) {
      const l = KIE_LEGACY[ctx.model];
      create = l.create;
      poll = l.record;
      body = { ...l.body(ctx), ...(ctx.input.params ?? {}) };
    } else {
      const model = ctx.model || (ctx.capability === 'audio_tts' ? KIE_TTS_DEFAULT : '');
      if (!model) throw new ProviderError('Bitte ein kie.ai-Modell angeben, z. B. google/nano-banana');
      create = MARKET_CREATE;
      body = { model, input: kieMarketInput({ ...ctx, model }) };
    }
    if (ctx.callbackUrl && !body.callBackUrl) body.callBackUrl = ctx.callbackUrl;
    const data = unwrap(await jsonCall(ctx.fetch, 'POST', `${base}${create}`, headers, body, 60_000, 'kie.ai'), 'Auftrag');
    const taskId = data?.taskId ?? data?.task_id ?? data?.id;
    if (!taskId) throw new ProviderError('kie.ai hat keine Task-ID geliefert');
    // speech is short and someone is waiting for it (Jarvis, "Stimme testen") – ask again quickly
    return { status: 'pending', state: { task_id: String(taskId), record: recordPath(create, poll) }, pollAfterMs: ctx.capability === 'video' ? 10_000 : ctx.capability === 'audio_tts' ? KIE_TTS_POLL_MS : 4000 };
  },
  async poll(ctx, state) {
    const { headers } = authFor(ctx.conn, 'bearer');
    const base = baseOf(ctx.conn, BASE);
    const url = `${base}${safePath(state.record || MARKET_RECORD, 'Abfrage-Pfad')}?taskId=${encodeURIComponent(state.task_id)}`;
    const data = unwrap(await jsonCall(ctx.fetch, 'GET', url, headers, undefined, 30_000, 'kie.ai'), 'Abfrage');
    const step = kieRecord(ctx, data);
    if (step.status === 'pending') return { ...step, state, pollAfterMs: ctx.capability === 'video' ? 12_000 : ctx.capability === 'audio_tts' ? KIE_TTS_POLL_MS : 5000 };
    return step;
  },
  // kie has no voice list endpoint; its docs list a fixed set of ElevenLabs voices (not tied to a language: the model speaks the text's)
  async voices() {
    return KIE_VOICES;
  },
  async webhook(ctx, state, req) {
    // Only with a webhook HMAC key (kie settings) can the message itself be trusted.
    const secret = ctx.conn.webhookSecret;
    const ts = String(req.headers['x-webhook-timestamp'] ?? '');
    const sig = String(req.headers['x-webhook-signature'] ?? '');
    if (!secret || !ts || !sig) return null;
    const taskId = String(req.body?.data?.task_id ?? req.body?.data?.taskId ?? '');
    if (!taskId || taskId !== state.task_id) throw new ProviderError('Falscher Auftrag', false, 401);
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 600) throw new ProviderError('Signatur abgelaufen', false, 401);
    const expected = createHmac('sha256', secret).update(`${taskId}.${ts}`).digest('base64');
    if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) throw new ProviderError('Signatur ungültig', false, 401);
    // Signed – still fetch the record: callback bodies differ per model, the record does not.
    return null;
  },
};
