import { describe, expect, it } from 'vitest';
import { authFor } from '../server/services/genmedia/http.js';
import { parseWav, pcmToBuffer, pcmToUlaw, ulawSilence, ulawToPcm, wavFromUlaw } from '../server/services/voice-audio.js';
import { BatchLiveStt, assemblyaiOpen, deepgramOpen } from '../server/services/voice-stream-stt.js';
import { AsyncQueue, TTS_STREAMERS, azureStream, cartesiaStream, chunks, deepgramStream, elevenlabsStream, googleStream, openaiStream } from '../server/services/voice-stream-tts.js';
import { AudioStore, PhraseCache, playNoun, prependTo, recordTurnNoun, streamToken, streamTwiml, turnTwiml, verifyStreamToken, wsUrl } from '../server/services/voice-twiml.js';
import { VoiceError, type LiveSttHandlers, type StreamCtx, type StreamTtsReq } from '../server/services/voice-types.js';
import type { WsClientLike } from '../server/services/voice-ws.js';

/** Streaming speech: text to speech as µ-law chunks, live speech recognition, the utterance cutter, TwiML and tokens. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 1500) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('Zeitüberschreitung im Test');
    await sleep(3);
  }
};
const sineBuf = (hz: number, rate: number, seconds: number, amp = 9000) => pcmToBuffer(Int16Array.from({ length: Math.round(rate * seconds) }, (_, i) => Math.round(amp * Math.sin((2 * Math.PI * hz * i) / rate))));
const tone = (ms: number) => pcmToUlaw(Int16Array.from({ length: (ms * 8000) / 1000 }, (_, i) => Math.round(9000 * Math.sin((2 * Math.PI * 300 * i) / 8000))));
function level(pcm: Int16Array, hz: number, rate: number): number {
  const w = (2 * Math.PI * hz) / rate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (const x of pcm) {
    const s = x + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return (2 * Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2)) / pcm.length;
}

// --- fakes ------------------------------------------------------------------------------------------------------------

class FakeSock implements WsClientLike {
  readyState = 0;
  binaryType = 'blob';
  sent: (string | ArrayBufferLike | ArrayBufferView)[] = [];
  closed: { code?: number } | null = null;
  onopen: any = null;
  onmessage: any = null;
  onerror: any = null;
  onclose: any = null;
  constructor(
    readonly url: string,
    readonly protocols?: string[],
  ) {}
  send(d: any) {
    this.sent.push(d);
  }
  close(code?: number) {
    this.readyState = 3;
    this.closed = { code };
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  msg(o: unknown) {
    this.onmessage?.({ data: typeof o === 'string' || Buffer.isBuffer(o) ? o : JSON.stringify(o) });
  }
  drop(code = 1006, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  texts() {
    return this.sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s));
  }
}
function socks() {
  const list: FakeSock[] = [];
  return { list, factory: (url: string, protocols?: string[]) => (list.push(new FakeSock(url, protocols)), list.at(-1)!) };
}
const stream = (parts: Buffer[], status = 200) =>
  new Response(
    new ReadableStream({
      async start(c) {
        for (const p of parts) {
          c.enqueue(new Uint8Array(p));
          await sleep(1);
        }
        c.close();
      },
    }),
    { status },
  );
interface Seen {
  url: string;
  init: RequestInit;
  json: any;
}
function ctxOf(provider: string, over: Record<string, unknown> = {}, answer: (u: string, i: RequestInit) => Response = () => stream([Buffer.alloc(0)])) {
  const seen: Seen[] = [];
  const s = socks();
  const conn = { connectionId: 'c1', provider, apiKey: 'key-123', ...over } as any;
  const ctx: StreamCtx = {
    conn,
    fetch: async (url, init) => {
      let json: any;
      try {
        json = JSON.parse(String(init.body));
      } catch {
        /* not json */
      }
      seen.push({ url, init, json });
      return answer(url, init);
    },
    ws: s.factory,
  };
  return { ctx, seen, socks: s, conn };
}
const req = (over: Partial<StreamTtsReq> = {}): StreamTtsReq => ({ text: 'Guten Tag', voice: '', language: 'de', model: '', ...over });
const collect = async (g: AsyncGenerator<Buffer>) => {
  const out: Buffer[] = [];
  for await (const c of g) out.push(c);
  return Buffer.concat(out);
};
const hdr = (s: Seen, n: string) => new Headers(s.init.headers as any).get(n);

// --- text to speech ---------------------------------------------------------------------------------------------------

describe('streaming text to speech', () => {
  it('knows a streamer for every provider that announces live speech', () => {
    for (const id of ['openai', 'speech_local', 'elevenlabs', 'cartesia', 'deepgram', 'azure_speech', 'google_speech']) expect(TTS_STREAMERS[id], id).toBeTypeOf('function');
  });

  it('turns OpenAI\'s 24 kHz PCM into µ-law 8 kHz, whatever the chunk sizes', async () => {
    const pcm = sineBuf(440, 24000, 0.5);
    const parts = [pcm.subarray(0, 1001), pcm.subarray(1001, 4003), pcm.subarray(4003, 4004), pcm.subarray(4004)];
    const r = ctxOf('openai', { baseUrl: 'https://api.openai.com', authStyle: 'bearer' }, () => stream(parts));
    const ulaw = await collect(openaiStream(r.ctx, req({ voice: 'nova', model: 'gpt-4o-mini-tts', instructions: 'ruhig' })));
    expect(r.seen[0].url).toBe('https://api.openai.com/v1/audio/speech');
    expect(hdr(r.seen[0], 'authorization')).toBe('Bearer key-123');
    expect(r.seen[0].json).toMatchObject({ model: 'gpt-4o-mini-tts', voice: 'nova', response_format: 'pcm', instructions: 'ruhig' });
    expect(Math.abs(ulaw.length - 4000)).toBeLessThan(40);
    const back = ulawToPcm(ulaw);
    expect(level(back, 440, 8000)).toBeGreaterThan(7000);
    expect(level(back, 1500, 8000)).toBeLessThan(300);
  });

  it('works against a local OpenAI-compatible server (speed instead of instructions, own base URL)', async () => {
    const r = ctxOf('speech_local', { baseUrl: 'http://localhost:8880/v1', apiKey: '' }, () => stream([sineBuf(300, 24000, 0.1)]));
    await collect(openaiStream(r.ctx, req({ model: 'kokoro', voice: 'af_bella', speed: 1.2, instructions: 'x' })));
    expect(r.seen[0].url).toBe('http://localhost:8880/v1/audio/speech');
    expect(r.seen[0].json).toMatchObject({ model: 'kokoro', voice: 'af_bella', speed: 1.2 });
    expect(r.seen[0].json.instructions).toBeUndefined();
  });

  it('passes ElevenLabs µ-law through and asks for it', async () => {
    const audio = [Buffer.alloc(320, 0x7f), Buffer.alloc(160, 0x55)];
    const r = ctxOf('elevenlabs', { authStyle: 'header:xi-api-key' }, () => stream(audio));
    const out = await collect(elevenlabsStream(r.ctx, req({ voice: 'abc/../x', speed: 5, language: 'de-DE' })));
    expect(out.length).toBe(480);
    expect(r.seen[0].url).toBe('https://api.elevenlabs.io/v1/text-to-speech/abcx/stream?output_format=ulaw_8000');
    expect(hdr(r.seen[0], 'xi-api-key')).toBe('key-123');
    expect(r.seen[0].json).toMatchObject({ text: 'Guten Tag', model_id: 'eleven_flash_v2_5', language_code: 'de', voice_settings: { speed: 1.2 } });
  });

  it('speaks through the ElevenLabs WebSocket: text in, base64 µ-law out, until isFinal – and stops when aborted', async () => {
    const r = ctxOf('elevenlabs');
    const run = collect(elevenlabsStream(r.ctx, req({ voice: 'v1', ws: true, speed: 1.1 })));
    await until(() => r.socks.list.length === 1);
    const s = r.socks.list[0];
    expect(s.url).toBe('wss://api.elevenlabs.io/v1/text-to-speech/v1/stream-input?model_id=eleven_flash_v2_5&output_format=ulaw_8000&auto_mode=true&inactivity_timeout=20&language_code=de');
    s.open();
    expect(s.texts().map((m) => m.text)).toEqual([' ', 'Guten Tag ', '']);
    expect(s.texts()[0]).toMatchObject({ xi_api_key: 'key-123', voice_settings: { speed: 1.1 } });
    expect(s.texts()[1].flush).toBe(true);
    s.msg({ audio: Buffer.alloc(160, 1).toString('base64') });
    s.msg('kein json');
    s.msg({ audio: Buffer.alloc(80, 2).toString('base64'), isFinal: false });
    s.msg({ isFinal: true });
    expect((await run).length).toBe(240);
    expect(s.closed?.code).toBe(1000);

    const err = ctxOf('elevenlabs');
    const failing = collect(elevenlabsStream(err.ctx, req({ ws: true })));
    await until(() => err.socks.list.length === 1);
    err.socks.list[0].open();
    err.socks.list[0].msg({ message_type: 'error', message: 'quota_exceeded' });
    await expect(failing).rejects.toMatchObject({ message: expect.stringContaining('quota_exceeded') });

    const drop = ctxOf('elevenlabs');
    const dropped = collect(elevenlabsStream(drop.ctx, req({ ws: true })));
    await until(() => drop.socks.list.length === 1);
    drop.socks.list[0].open();
    drop.socks.list[0].drop(1011, 'internal');
    await expect(dropped).rejects.toMatchObject({ retryable: true });

    const ac = new AbortController();
    const cut = ctxOf('elevenlabs');
    const cancelled = collect(elevenlabsStream(cut.ctx, req({ ws: true, signal: ac.signal })));
    await until(() => cut.socks.list.length === 1);
    cut.socks.list[0].open();
    cut.socks.list[0].msg({ audio: Buffer.alloc(160, 1).toString('base64') });
    ac.abort();
    expect((await cancelled).length).toBe(160);
    expect(cut.socks.list[0].closed).not.toBeNull();
  });

  it('asks Cartesia, Deepgram and Azure for µ-law 8 kHz directly (Cartesia needs a voice id)', async () => {
    const audio = [Buffer.alloc(200, 9)];
    const c = ctxOf('cartesia', { authStyle: 'header:x-api-key' }, () => stream(audio));
    await expect(collect(cartesiaStream(c.ctx, req()))).rejects.toThrow('Stimmen-ID');
    expect((await collect(cartesiaStream(c.ctx, req({ voice: 'v-1', model: 'sonic-3', speed: 1.3 })))).length).toBe(200);
    expect(c.seen[0].url).toBe('https://api.cartesia.ai/tts/bytes');
    expect(hdr(c.seen[0], 'cartesia-version')).toBe('2025-04-16');
    expect(c.seen[0].json).toMatchObject({ model_id: 'sonic-3', output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 }, voice: { mode: 'id', id: 'v-1' }, generation_config: { speed: 1.3 } });

    const d = ctxOf('deepgram', { authStyle: 'token' }, () => stream(audio));
    await collect(deepgramStream(d.ctx, req({ voice: 'aura-2-julius-de' })));
    expect(d.seen[0].url).toBe('https://api.deepgram.com/v1/speak?model=aura-2-julius-de&encoding=mulaw&sample_rate=8000&container=none');
    expect(hdr(d.seen[0], 'authorization')).toBe('Token key-123');

    const a = ctxOf('azure_speech', { baseUrl: 'https://germanywestcentral.api.cognitive.microsoft.com', authStyle: 'header:ocp-apim-subscription-key' }, () => stream(audio));
    await collect(azureStream(a.ctx, req({ voice: 'de-DE-ConradNeural', speed: 1.2 })));
    expect(a.seen[0].url).toBe('https://germanywestcentral.tts.speech.microsoft.com/cognitiveservices/v1');
    expect(hdr(a.seen[0], 'x-microsoft-outputformat')).toBe('raw-8khz-8bit-mono-mulaw');
    expect(String(a.seen[0].init.body)).toContain('<prosody rate="+20%">Guten Tag</prosody>');
  });

  it('decodes Google\'s µ-law WAV answer and reports a missing or broken one', async () => {
    const wav = wavFromUlaw(tone(100));
    const ok = ctxOf('google_speech', { authStyle: 'header:x-goog-api-key' }, () => new Response(JSON.stringify({ audioContent: wav.toString('base64') }), { status: 200 }));
    const out = await collect(googleStream(ok.ctx, req({ speed: 1.5 })));
    expect(out.length).toBe(800);
    expect(ok.seen[0].json).toMatchObject({ audioConfig: { audioEncoding: 'MULAW', sampleRateHertz: 8000, speakingRate: 1.5 }, voice: { languageCode: 'de-DE', name: 'de-DE-Neural2-F' } });
    const none = ctxOf('google_speech', {}, () => new Response('{}', { status: 200 }));
    await expect(collect(googleStream(none.ctx, req()))).rejects.toThrow('keine Sprachausgabe');
  });

  it('explains provider errors and marks the retryable ones', async () => {
    const e401 = ctxOf('openai', {}, () => new Response(JSON.stringify({ error: { message: 'Incorrect API key' } }), { status: 401 }));
    await expect(collect(openaiStream(e401.ctx, req()))).rejects.toMatchObject({ message: 'OpenAI: Incorrect API key (HTTP 401) – Schlüssel prüfen', retryable: false, status: 401, provider: 'openai' });
    const e429 = ctxOf('elevenlabs', {}, () => new Response(JSON.stringify({ detail: { message: 'Too many' } }), { status: 429 }));
    await expect(collect(elevenlabsStream(e429.ctx, req()))).rejects.toMatchObject({ retryable: true, message: expect.stringContaining('Limit erreicht') });
    const e500 = ctxOf('cartesia', {}, () => new Response('Server kaputt', { status: 503 }));
    const err = await collect(cartesiaStream(e500.ctx, req({ voice: 'v' }))).catch((e) => e);
    expect(err).toBeInstanceOf(VoiceError);
    expect(err.retryable).toBe(true);
  });

  it('hands the abort signal to the HTTP request (barge-in cancels it)', async () => {
    const ac = new AbortController();
    const r = ctxOf('deepgram', {}, () => stream([Buffer.alloc(10)]));
    await collect(deepgramStream(r.ctx, req({ signal: ac.signal })));
    expect(r.seen[0].init.signal).toBe(ac.signal);
  });

  it('reads bodies without a stream and bridges socket events into async iteration', async () => {
    const plain = new Response(Buffer.alloc(5, 1));
    Object.defineProperty(plain, 'body', { value: null });
    expect((await collect(chunks(plain))).length).toBe(5);
    const q = new AsyncQueue<number>();
    q.push(1);
    setTimeout(() => (q.push(2), q.end()), 5);
    const got: number[] = [];
    for await (const n of q) got.push(n);
    expect(got).toEqual([1, 2]);
    const f = new AsyncQueue<number>();
    f.push(7);
    f.fail(new Error('kaputt'));
    const it = f[Symbol.asyncIterator]();
    expect((await it.next()).value).toBe(7);
    await expect(it.next()).rejects.toThrow('kaputt');
  });

  it('shares header building with the one-shot adapters', () => {
    expect(authFor({ connectionId: 'c', provider: 'deepgram', apiKey: 'k', authStyle: 'token' }, 'token').headers.authorization).toBe('Token k');
  });
});

// --- live speech recognition ----------------------------------------------------------------------------------------------

function handlers() {
  const log: { partial: string[]; final: { text: string; speechFinal: boolean }[]; started: number; errors: Error[]; closed: number } = { partial: [], final: [], started: 0, errors: [], closed: 0 };
  const h: LiveSttHandlers = {
    onPartial: (t) => void log.partial.push(t),
    onFinal: (text, i) => void log.final.push({ text, speechFinal: i.speechFinal }),
    onSpeechStarted: () => void log.started++,
    onError: (e) => void log.errors.push(e),
    onClose: () => void log.closed++,
  };
  return { log, h };
}
const OPTS = { language: 'de-DE', model: '', endpointMs: 700 };

describe('Deepgram live transcription', () => {
  it('connects with the key as sub-protocol, µ-law parameters and keeps early audio until the socket is open', async () => {
    const r = ctxOf('deepgram');
    const { h } = handlers();
    const stt = await deepgramOpen(r.ctx, OPTS, h);
    const s = r.socks.list[0];
    const u = new URL(s.url);
    expect(`${u.protocol}//${u.host}${u.pathname}`).toBe('wss://api.deepgram.com/v1/listen');
    for (const [k, v] of Object.entries({ model: 'nova-3', encoding: 'mulaw', sample_rate: '8000', channels: '1', interim_results: 'true', language: 'de', endpointing: '350', utterance_end_ms: '1000' })) expect(u.searchParams.get(k), k).toBe(v);
    expect(s.protocols).toEqual(['token', 'key-123']);
    expect(s.url).not.toContain('key-123');
    stt.push(Buffer.alloc(160, 1));
    stt.push(Buffer.alloc(160, 2));
    expect(s.sent).toHaveLength(0);
    s.open();
    expect(s.sent).toHaveLength(2);
    stt.push(Buffer.alloc(160, 3));
    expect(s.sent).toHaveLength(3);
  });

  it('turns Results into partials and finals (speech_final or UtteranceEnd ends the turn)', async () => {
    const r = ctxOf('deepgram', { baseUrl: 'https://api.eu.deepgram.com' });
    const { h, log } = handlers();
    await deepgramOpen(r.ctx, OPTS, h);
    const s = r.socks.list[0];
    expect(s.url).toMatch(/^wss:\/\/api\.eu\.deepgram\.com\//);
    s.open();
    const result = (transcript: string, o: { is_final?: boolean; speech_final?: boolean } = {}) => s.msg({ type: 'Results', is_final: !!o.is_final, speech_final: !!o.speech_final, channel: { alternatives: [{ transcript }] } });
    s.msg({ type: 'SpeechStarted' });
    result('ich möch');
    result('ich möchte', { is_final: true });
    result('einen Termin', { is_final: false });
    result('einen Termin', { is_final: true, speech_final: true });
    expect(log.started).toBe(1);
    expect(log.partial).toEqual(['ich möch', 'ich möchte', 'ich möchte einen Termin']);
    expect(log.final).toEqual([{ text: 'ich möchte einen Termin', speechFinal: true }]);
    result('Montag', { is_final: true });
    s.msg({ type: 'UtteranceEnd' });
    expect(log.final.at(-1)).toEqual({ text: 'Montag', speechFinal: true });
    s.msg({ type: 'UtteranceEnd' }); // nothing pending
    expect(log.final).toHaveLength(2);
    result('', { is_final: true, speech_final: true }); // silence
    expect(log.final).toHaveLength(2);
    s.msg('kein json');
  });

  it('reports provider errors and dropped sockets, finalizes and closes cleanly', async () => {
    const r = ctxOf('deepgram');
    const { h, log } = handlers();
    const stt = await deepgramOpen(r.ctx, OPTS, h);
    const s = r.socks.list[0];
    s.open();
    stt.finalize();
    expect(s.texts().at(-1)).toEqual({ type: 'Finalize' });
    s.msg({ type: 'Error', description: 'Bad audio' });
    expect(log.errors[0].message).toBe('Deepgram: Bad audio');
    s.drop(1011, 'internal');
    expect(log.errors[1]).toMatchObject({ retryable: true, message: expect.stringContaining('1011') });
    expect(log.closed).toBe(1);

    const q = ctxOf('deepgram');
    const b = handlers();
    const closing = await deepgramOpen(q.ctx, OPTS, b.h);
    q.socks.list[0].open();
    closing.close();
    expect(q.socks.list[0].texts().at(-1)).toEqual({ type: 'CloseStream' });
    expect(q.socks.list[0].closed?.code).toBe(1000);
    closing.close();
    q.socks.list[0].drop(1000);
    expect(b.log.errors).toHaveLength(0);
  });
});

describe('AssemblyAI live transcription', () => {
  it('swaps the key for a short-lived token, never puts the key in the URL and sends 100 ms messages', async () => {
    const r = ctxOf('assemblyai', { authStyle: 'header:authorization' }, () => new Response(JSON.stringify({ token: 'tmp-token-9' }), { status: 200 }));
    const { h, log } = handlers();
    const stt = await assemblyaiOpen(r.ctx, { language: 'de', model: '', endpointMs: 900 }, h);
    expect(r.seen[0].url).toBe('https://streaming.assemblyai.com/v3/token?expires_in_seconds=300');
    expect(hdr(r.seen[0], 'authorization')).toBe('key-123');
    const s = r.socks.list[0];
    const u = new URL(s.url);
    expect(u.host).toBe('streaming.assemblyai.com');
    expect(u.pathname).toBe('/v3/ws');
    for (const [k, v] of Object.entries({ sample_rate: '8000', encoding: 'pcm_mulaw', token: 'tmp-token-9', speech_model: 'universal-streaming-multilingual', min_end_of_turn_silence_when_confident: '900' })) expect(u.searchParams.get(k), k).toBe(v);
    expect(s.url).not.toContain('key-123');
    s.open();
    for (let i = 0; i < 4; i++) stt.push(Buffer.alloc(160, 1));
    expect(s.sent).toHaveLength(0);
    stt.push(Buffer.alloc(160, 1));
    expect(s.sent).toHaveLength(1);
    expect((s.sent[0] as Buffer).length).toBe(800);
    s.msg({ type: 'Turn', transcript: 'Guten', end_of_turn: false });
    s.msg({ type: 'Turn', transcript: 'Guten Tag', end_of_turn: true });
    s.msg({ type: 'Turn', transcript: '', end_of_turn: true });
    s.msg({ error: 'Rate limit' });
    expect(log.partial).toEqual(['Guten']);
    expect(log.final).toEqual([{ text: 'Guten Tag', speechFinal: true }]);
    expect(log.errors[0].message).toBe('AssemblyAI: Rate limit');
    stt.finalize();
    expect(s.texts().at(-1)).toEqual({ type: 'ForceEndpoint' });
    stt.close();
    expect(s.texts().at(-1)).toEqual({ type: 'Terminate' });
  });

  it('uses the EU host and the English model, and fails clearly when no token comes', async () => {
    const r = ctxOf('assemblyai', { baseUrl: 'https://api.eu.assemblyai.com' }, () => new Response(JSON.stringify({ token: 't' }), { status: 200 }));
    await assemblyaiOpen(r.ctx, { language: 'en', model: '', endpointMs: 700 }, handlers().h);
    expect(r.seen[0].url).toContain('streaming.eu.assemblyai.com');
    expect(new URL(r.socks.list[0].url).searchParams.get('speech_model')).toBeNull();
    const bad = ctxOf('assemblyai', {}, () => new Response('{}', { status: 401 }));
    await expect(assemblyaiOpen(bad.ctx, OPTS, handlers().h)).rejects.toMatchObject({ message: expect.stringContaining('401'), provider: 'assemblyai' });
  });
});

describe('utterance-wise transcription for every other provider', () => {
  const frames = (ms: number, loud: boolean) => (loud ? tone(ms) : ulawSilence(ms));
  function feed(stt: BatchLiveStt, parts: [number, boolean][]) {
    for (const [ms, loud] of parts) {
      const b = frames(ms, loud);
      for (let i = 0; i < b.length; i += 160) stt.push(b.subarray(i, i + 160));
    }
  }

  it('cuts the call at pauses and transcribes each utterance as a WAV, in order', async () => {
    const wavs: Buffer[] = [];
    const { h, log } = handlers();
    const stt = new BatchLiveStt(
      async (wav) => {
        wavs.push(wav);
        await sleep(wavs.length === 1 ? 15 : 1);
        return `Satz ${wavs.length}`;
      },
      h,
      { endpointMs: 400 },
    );
    feed(stt, [[300, false], [600, true], [700, false], [500, true], [700, false]]);
    await until(() => log.final.length === 2);
    expect(log.final).toEqual([
      { text: 'Satz 1', speechFinal: true },
      { text: 'Satz 2', speechFinal: true },
    ]);
    expect(log.started).toBe(2);
    const w = parseWav(wavs[0])!;
    expect(w.rate).toBe(8000);
    const ms = (w.data.length / 2 / 8000) * 1000;
    // ~300 ms pre-roll + 600 ms speech + ~200 ms of the trailing pause
    expect(ms).toBeGreaterThan(700);
    expect(ms).toBeLessThan(1400);
  });

  it('drops clicks, passes errors on and ignores everything after close', async () => {
    const { h, log } = handlers();
    let calls = 0;
    const stt = new BatchLiveStt(
      async () => {
        calls++;
        if (calls === 1) throw new Error('Anbieter down');
        return 'ok';
      },
      h,
      { endpointMs: 300, minSpeechMs: 200 },
    );
    feed(stt, [[400, false], [80, true], [500, false]]); // a click
    await sleep(30);
    expect(calls).toBe(0);
    feed(stt, [[500, true], [500, false]]);
    await until(() => log.errors.length === 1);
    expect(log.errors[0].message).toBe('Anbieter down');
    stt.close();
    expect(log.closed).toBe(1);
    feed(stt, [[500, true], [500, false]]);
    await sleep(30);
    expect(calls).toBe(1);
    expect(log.final).toEqual([]);
  });

  it('cuts very long speech into pieces and flushes on demand', async () => {
    const { h, log } = handlers();
    const texts: string[] = [];
    const stt = new BatchLiveStt(async () => `Teil ${texts.push('x')}`, h, { endpointMs: 600, maxUtteranceMs: 500 });
    feed(stt, [[200, false], [1700, true]]);
    await until(() => log.final.length >= 2);
    await sleep(30);
    expect(log.final.every((f) => !f.speechFinal)).toBe(true);
    const before = log.final.length;
    stt.finalize();
    await until(() => log.final.length > before);
    expect(log.final.at(-1)!.speechFinal).toBe(true);
  });
});

// --- TwiML, tokens, short-lived audio ---------------------------------------------------------------------------------------

describe('phone TwiML, stream tokens and stored audio', () => {
  it('builds <Connect><Stream> with escaped parameters, the record/play nouns and splices a Play before a transfer', () => {
    const x = streamTwiml({ url: 'wss://x.example/hooks/twilio/stream/L1', action: 'https://x.example/hooks/twilio/voice-ai-stream-end/L1', params: { token: 'a&b"c' } });
    expect(x).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Connect action="https://x.example/hooks/twilio/voice-ai-stream-end/L1" method="POST"><Stream url="wss://x.example/hooks/twilio/stream/L1"><Parameter name="token" value="a&amp;b&quot;c"/></Stream></Connect></Response>');
    expect(recordTurnNoun({ action: 'https://x/t' })).toBe('<Record action="https://x/t" method="POST" maxLength="30" timeout="2" playBeep="false" trim="trim-silence"/>');
    expect(playNoun('https://x/a.mp3?x=1&y=2')).toBe('<Play>https://x/a.mp3?x=1&amp;y=2</Play>');
    expect(turnTwiml(playNoun('u'), '<Hangup/>')).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Play>u</Play><Hangup/></Response>');
    expect(prependTo('<Response><Dial/></Response>', '<Play>u</Play>')).toBe('<Response><Play>u</Play><Dial/></Response>');
    expect(prependTo('<Response><Dial/></Response>', '')).toBe('<Response><Dial/></Response>');
    expect(wsUrl('https://gh.example.com/', '/hooks/x')).toBe('wss://gh.example.com/hooks/x');
    expect(wsUrl('http://localhost:3000', '/hooks/x')).toBe('ws://localhost:3000/hooks/x');
  });

  it('ties a stream token to one call of one sub-account and lets it expire', () => {
    const t = streamToken('secret-1', 'LOC1', 'CA1', 1_000_000_000_000);
    expect(verifyStreamToken('secret-1', t, 'LOC1', 'CA1', 1_000_000_000_500)).toBe(true);
    expect(verifyStreamToken('secret-2', t, 'LOC1', 'CA1', 1_000_000_000_500)).toBe(false);
    expect(verifyStreamToken('secret-1', t, 'LOC2', 'CA1', 1_000_000_000_500)).toBe(false);
    expect(verifyStreamToken('secret-1', t, 'LOC1', 'CA2', 1_000_000_000_500)).toBe(false);
    expect(verifyStreamToken('secret-1', t, 'LOC1', 'CA1', 1_000_000_000_000 + 11 * 60_000)).toBe(false);
    const [exp, sig] = t.split('.');
    expect(verifyStreamToken('secret-1', `${Number(exp) + 600000}.${sig}`, 'LOC1', 'CA1', 1_000_000_000_500)).toBe(false);
    for (const bad of ['', undefined, 'x', '123.abc', `${exp}.${sig.slice(1)}`, `${exp}.`]) expect(verifyStreamToken('secret-1', bad as any, 'LOC1', 'CA1', 1_000_000_000_500)).toBe(false);
  });

  it('keeps audio for Twilio for a while, within a size and count budget', () => {
    const store = new AudioStore(1000, 3);
    const a = store.put('L1', Buffer.alloc(400, 1), 'audio/mpeg');
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(store.get(a)).toMatchObject({ locationId: 'L1', mime: 'audio/mpeg' });
    const b = store.put('L1', Buffer.alloc(400, 2), 'audio/mpeg');
    const c = store.put('L2', Buffer.alloc(400, 3), 'audio/wav');
    // the oldest one makes room when the byte budget is exceeded
    expect(store.get(a)).toBeUndefined();
    expect(store.get(b)).toBeDefined();
    expect(store.get(c)).toBeDefined();
    const d = store.put('L1', Buffer.alloc(10), 'audio/mpeg');
    const e = store.put('L1', Buffer.alloc(10), 'audio/mpeg');
    expect(store.size).toBeLessThanOrEqual(3);
    expect(store.get(e)).toBeDefined();
    expect(store.get(d) ?? store.get(b)).toBeDefined();
    const short = store.put('L1', Buffer.alloc(5), 'audio/mpeg', -1);
    expect(store.get(short)).toBeUndefined();
    expect(store.get('nope')).toBeUndefined();
  });

  it('caches phrases for a limited time and size', async () => {
    const c = new PhraseCache<number>(20, 2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    expect(c.get('a')).toBeUndefined();
    expect(c.get('c')).toBe(3);
    await sleep(30);
    expect(c.get('c')).toBeUndefined();
  });
});
