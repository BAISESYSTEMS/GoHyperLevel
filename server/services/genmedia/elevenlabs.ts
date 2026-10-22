import { authFor, baseOf, ensureOk, jsonCall, multipart } from './http.js';
import { MAX_INPUT_BYTES } from './media.js';
import { ProviderError, type Adapter, type Step } from './types.js';

/**
 * ElevenLabs (https://elevenlabs.io/docs/api-reference), header `xi-api-key`, synchronous:
 * - speech: POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_128 {text, model_id} → MP3
 * - music: POST /v1/music {prompt, music_length_ms, model_id} → MP3
 * - transcription: POST /v1/speech-to-text (multipart model_id + file) → {text}
 * - voices: GET /v2/voices
 */

const BASE = 'https://api.elevenlabs.io';
/** "George" – the voice of ElevenLabs' own examples, used when none is chosen. */
export const DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb';

const charCost = (h: Record<string, string>) => {
  const n = Number(h['character-cost'] ?? h['x-character-count']);
  return Number.isFinite(n) && n > 0 ? { amount: n, unit: 'Zeichen' } : undefined;
};

export const elevenlabsAdapter: Adapter = {
  id: 'elevenlabs',
  label: 'ElevenLabs',
  capabilities: ['audio_tts', 'audio_music', 'stt'],
  defaultBase: BASE,
  defaultAuth: 'header:xi-api-key',
  models: {
    audio_tts: [
      { id: 'eleven_multilingual_v2', label: 'Multilingual v2 (beste Qualität)' },
      { id: 'eleven_v3', label: 'Eleven v3 (ausdrucksstark)' },
      { id: 'eleven_flash_v2_5', label: 'Flash v2.5 (schnell, günstig)' },
      { id: 'eleven_turbo_v2_5', label: 'Turbo v2.5' },
    ],
    audio_music: [{ id: 'music_v1', label: 'Eleven Music' }],
    stt: [
      { id: 'scribe_v2', label: 'Scribe v2' },
      { id: 'scribe_v1', label: 'Scribe v1' },
    ],
  },
  async voices(ctx) {
    const { headers } = authFor(ctx.conn, 'header:xi-api-key');
    const r = await jsonCall(ctx.fetch, 'GET', `${baseOf(ctx.conn, BASE)}/v2/voices?page_size=100`, headers, undefined, 15_000, 'ElevenLabs');
    return ((r.voices ?? []) as any[]).map((v) => ({ id: String(v.voice_id), name: [v.name, v.category && v.category !== 'premade' ? `(${v.category})` : ''].filter(Boolean).join(' '), preview: v.preview_url || undefined, lang: v.labels?.language || undefined, gender: v.labels?.gender || undefined }));
  },
  async submit(ctx): Promise<Step> {
    const { headers } = authFor(ctx.conn, 'header:xi-api-key');
    const base = baseOf(ctx.conn, BASE);
    const p = ctx.input.params ?? {};
    if (ctx.capability === 'audio_tts') {
      const voice = (ctx.input.voice || DEFAULT_VOICE).replace(/[^\w-]/g, '');
      const body = { text: ctx.input.prompt, model_id: ctx.model || 'eleven_multilingual_v2', ...(ctx.input.language ? { language_code: ctx.input.language } : {}), ...(ctx.input.speed && ctx.input.speed !== 1 ? { voice_settings: { speed: Math.max(0.7, Math.min(1.2, ctx.input.speed)) } } : {}), ...p };
      const r = await ctx.fetch(`${base}/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept: 'audio/mpeg' }, body: JSON.stringify(body), timeoutMs: 180_000, maxBytes: 60 * 1024 * 1024 });
      ensureOk(r, 'ElevenLabs');
      return { status: 'done', outputs: [{ data: r.body, mime: 'audio/mpeg' }], cost: charCost(r.headers) ?? { amount: ctx.input.prompt.length, unit: 'Zeichen', estimated: true } };
    }
    if (ctx.capability === 'audio_music') {
      const body = { prompt: ctx.input.prompt, model_id: ctx.model || 'music_v1', ...(ctx.input.duration ? { music_length_ms: Math.round(ctx.input.duration * 1000) } : {}), ...p };
      const r = await ctx.fetch(`${base}/v1/music`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept: 'audio/mpeg' }, body: JSON.stringify(body), timeoutMs: 300_000, maxBytes: 60 * 1024 * 1024 });
      ensureOk(r, 'ElevenLabs');
      return { status: 'done', outputs: [{ data: r.body, mime: 'audio/mpeg' }] };
    }
    if (ctx.capability === 'stt') {
      if (!ctx.input.audio) throw new ProviderError('Bitte eine Audio- oder Videodatei angeben');
      const f = await ctx.bytes(ctx.input.audio, MAX_INPUT_BYTES);
      const form = multipart({ model_id: ctx.model || 'scribe_v2', language_code: ctx.input.language, file: { filename: ctx.input.audio.name || 'audio', contentType: f.mime, data: f.data }, ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : (v as any)])) });
      const r = await ctx.fetch(`${base}/v1/speech-to-text`, { method: 'POST', headers: { ...headers, 'content-type': form.contentType }, body: form.body, timeoutMs: 300_000 });
      ensureOk(r, 'ElevenLabs');
      const j = r.json();
      if (typeof j?.text !== 'string') throw new ProviderError('ElevenLabs hat keinen Text geliefert');
      return { status: 'done', outputs: [], text: j.text };
    }
    throw new ProviderError('ElevenLabs kann das nicht');
  },
};
