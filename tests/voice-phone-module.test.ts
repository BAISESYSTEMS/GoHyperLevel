import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { retry } from '../server/services/anthropic.js';
import { twilioSignature } from '../server/services/twilio.js';
import { voiceTiming } from '../server/modules/voice-ai.js';
import { phoneTiming } from '../server/services/voice-phone.js';
import { pcmToUlaw, wavFromUlaw } from '../server/services/voice-audio.js';

/**
 * The KI-Telefonagent with the sub-account's own voice: Twilio's webhooks, the Media Stream over a real WebSocket,
 * recorded turns, fallbacks to Twilio's voices, voicemail transcription – with fake Claude, fake Twilio and fake providers.
 */

const SID = `AC${'0'.repeat(31)}1`;
const TOKEN = 'f'.repeat(32);
const TWILIO_NUMBER = '+4930123456';
const MOBILE = '+4915112345678';
const KEY = 'sk-ant-api03-testkey-abcdefghijklmnopqrstuvwxyz0123';
const callSid = (n: number) => `CA${String(n).padStart(32, '0')}`;
const recUrl = (c: string, account = SID) => `https://api.twilio.com/2010-04-01/Accounts/${account}/Recordings/RE${c.repeat(32)}`;
const STREAM_SID = `MZ${'1'.repeat(32)}`;
const EMPTY_ARGS = { calendar_id: '', date: '', time: '', first_name: '', last_name: '', email: '', message: '', title: '', reason: '' };
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(300, 3)]);
const WAV = wavFromUlaw(pcmToUlaw(Int16Array.from({ length: 1600 }, (_, i) => Math.round(8000 * Math.sin(i / 5)))));
const ULAW = Buffer.alloc(960, 0x40);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('Zeitüberschreitung im Test');
    await sleep(5);
  }
};

// --- fakes ---------------------------------------------------------------------------------------------------------------

const claude: { prompt: string }[] = [];
let respond: (prompt: string) => unknown = () => ({ say: 'Wie kann ich helfen?', action: 'none', args: EMPTY_ARGS });
let claudeDelay = 0;
const reply = (text: string) => ({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 800, output_tokens: 60 } });
const fakeClaude = (async (_url: string, init: any = {}) => {
  const body = init.body ? JSON.parse(init.body) : null;
  const prompt: string = body?.messages?.[0]?.content ?? '';
  claude.push({ prompt });
  if (claudeDelay) await sleep(claudeDelay);
  let out: unknown;
  if (prompt.includes('Aufgabe: Fasse dieses Telefonat')) out = { summary: 'Max Muster hat angerufen.', next_step: 'Zurückrufen.' };
  else if (prompt.includes('Aufgabe: Fasse diese Voicemail')) out = { summary: 'Frau Beispiel bittet um Rückruf wegen eines Termins.', next_step: 'Heute zurückrufen.' };
  else out = respond(prompt);
  return new Response(JSON.stringify(reply(typeof out === 'string' ? out : JSON.stringify(out))), { status: 200, headers: { 'content-type': 'application/json' } });
}) as unknown as typeof fetch;

const twilioCalls: { url: string; method: string }[] = [];
let recordingStatus = 200;
const fakeTwilio = (async (url: string, init: any = {}) => {
  twilioCalls.push({ url: String(url), method: init.method ?? 'GET' });
  if (init.method === 'DELETE') return new Response(null, { status: 204 });
  if (/\/Recordings\/RE\w+\.(wav|mp3)$/.test(String(url))) return recordingStatus === 200 ? new Response(new Uint8Array(String(url).endsWith('.mp3') ? MP3 : WAV), { status: 200 }) : new Response('', { status: recordingStatus });
  return new Response(JSON.stringify({ sid: 'X' }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as unknown as typeof fetch;

/** One-shot provider calls (adapters): speech, transcription. */
let transcript = 'Ich möchte einen Termin';
let ttsFail = false;
const providerCalls: { url: string; body: any }[] = [];
const genmediaFetch = async (url: string, init: any = {}) => {
  providerCalls.push({ url, body: init.body });
  if (/api\.elevenlabs\.io\/v1\/text-to-speech/.test(url)) return ttsFail ? new Response(JSON.stringify({ detail: { message: 'quota_exceeded' } }), { status: 402 }) : new Response(new Uint8Array(MP3), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  if (/api\.deepgram\.com\/v1\/listen/.test(url)) return new Response(JSON.stringify({ metadata: { duration: 3 }, results: { channels: [{ alternatives: [{ transcript }] }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify({ error: `no route ${url}` }), { status: 404 });
};

/** Streaming provider calls: text to speech as a chunked body. */
const streamCalls: { url: string; body: any }[] = [];
const voiceFetch = async (url: string, init: any = {}) => {
  streamCalls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
  if (ttsFail) return new Response(JSON.stringify({ detail: { message: 'quota_exceeded' } }), { status: 402 });
  return new Response(
    new ReadableStream({
      async start(c) {
        for (let i = 0; i < 3; i++) {
          c.enqueue(new Uint8Array(ULAW.subarray(i * 320, (i + 1) * 320)));
          await sleep(1);
        }
        c.close();
      },
    }),
    { status: 200 },
  );
};

class FakeSock {
  readyState = 0;
  binaryType = '';
  sent: unknown[] = [];
  onopen: any = null;
  onmessage: any = null;
  onerror: any = null;
  onclose: any = null;
  constructor(readonly url: string) {}
  send(d: unknown) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  say(text: string, speechFinal = true) {
    this.onmessage?.({ data: JSON.stringify({ type: 'Results', is_final: true, speech_final: speechFinal, channel: { alternatives: [{ transcript: text }] } }) });
  }
}
const sttSockets: FakeSock[] = [];

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let elevenId = '';
let deepgramId = '';
const flush = () => t.app.events.flush();

async function hook(name: string, params: Record<string, string>, opts: { query?: string; token?: string; sign?: boolean } = {}) {
  const path = `/hooks/twilio/${name}/${loc}${opts.query ?? ''}`;
  const signature = twilioSignature(opts.token ?? TOKEN, `http://localhost${path}`, params);
  const r = await t.api.raw(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(opts.sign === false ? {} : { 'x-twilio-signature': signature }) },
    body: new URLSearchParams(params).toString(),
  });
  return { status: r.status, text: await r.text() };
}
const inbound = (sid: string) => hook('voice', { CallSid: sid, From: '+4917011111', To: TWILIO_NUMBER, CallStatus: 'ringing' });
const session = (sid: string) => {
  const s = t.app.db.get<any>('SELECT * FROM voice_ai_sessions WHERE call_sid = ?', sid)!;
  return { ...s, transcript: JSON.parse(s.transcript), actions: JSON.parse(s.actions), outcomes: JSON.parse(s.outcomes) };
};
const turnRows = (sid: string) => t.app.db.all<any>('SELECT * FROM voice_turns WHERE call_sid = ? ORDER BY n', sid);
const setVoice = (patch: unknown) => t.api.put('/api/voice/settings', patch);

/** A real WebSocket client against the test server (like Twilio's). */
const clients: WebSocket[] = [];
function openStream(path: string) {
  const port = new URL(t.base).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  clients.push(ws);
  const state = { inbox: [] as any[], opened: false, closed: null as null | { code: number }, errored: false };
  ws.addEventListener('open', () => (state.opened = true));
  ws.addEventListener('message', (e) => state.inbox.push(JSON.parse(String(e.data))));
  ws.addEventListener('error', () => (state.errored = true));
  ws.addEventListener('close', (e) => (state.closed = { code: e.code }));
  const send = (o: unknown) => ws.send(JSON.stringify(o));
  return {
    state,
    send,
    ws,
    of: (ev: string) => state.inbox.filter((m) => m.event === ev),
    start: (sid: string, params: Record<string, string>, account = SID) => {
      send({ event: 'connected', protocol: 'Call', version: '1.0.0' });
      send({ event: 'start', sequenceNumber: '1', streamSid: STREAM_SID, start: { streamSid: STREAM_SID, accountSid: account, callSid: sid, tracks: ['inbound'], customParameters: params, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } });
    },
    echo: () => {
      for (const m of state.inbox.filter((x) => x.event === 'mark')) send({ event: 'mark', streamSid: STREAM_SID, mark: { name: m.mark.name } });
    },
    audioBytes: () => state.inbox.filter((m) => m.event === 'media').reduce((n, m) => n + Buffer.from(m.media.payload, 'base64').length, 0),
    ready: () => until(() => state.opened || state.closed !== null || state.errored),
    close: () => ws.close(),
  };
}

beforeAll(async () => {
  retry.ms = 1;
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  t.app.services.aiFetch = fakeClaude;
  t.app.services.twilioFetch = fakeTwilio;
  t.app.services.genmediaFetch = genmediaFetch;
  t.app.services.voiceFetch = voiceFetch;
  t.app.services.voiceWs = (url: string) => {
    const s = new FakeSock(url);
    sttSockets.push(s);
    return s;
  };
  await t.api.put('/api/telephony/settings', { account_sid: SID, auth_token: TOKEN, numbers: TWILIO_NUMBER, forward_to: MOBILE, hours_mode: 'always' });
  await t.api.put('/api/ai/settings', { api_key: KEY, enabled: true, facts: 'Zahnarztpraxis Dr. Sonne in Leipzig.' });
  await t.api.put('/api/voice-ai/settings', { mode: 'always', voice: 'Google.de-DE-Neural2-F' });
  elevenId = (await t.api.post('/api/ai-connections', { provider: 'elevenlabs', api_key: 'el-key-1234567890', capabilities: ['audio_tts'] })).data.id;
  deepgramId = (await t.api.post('/api/ai-connections', { provider: 'deepgram', api_key: 'dg-key-1234567890', capabilities: ['stt', 'audio_tts'] })).data.id;
}, 60_000);
afterEach(() => {
  for (const ws of clients.splice(0)) {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
});
afterAll(() => t.close());
beforeEach(async () => {
  claude.length = 0;
  twilioCalls.length = 0;
  providerCalls.length = 0;
  streamCalls.length = 0;
  sttSockets.length = 0;
  transcript = 'Ich möchte einen Termin';
  ttsFail = false;
  claudeDelay = 0;
  recordingStatus = 200;
  respond = () => ({ say: 'Gern. Wie ist Ihr Name?', action: 'none', args: EMPTY_ARGS });
  Object.assign(phoneTiming, { startMs: 1500, fillerMs: 4000, silenceMs: 60_000, markExtraMs: 400, bargeStartMs: 100, bargeGraceMs: 20, commitMs: 100 });
  Object.assign(voiceTiming, { replyMs: 9000, waitMs: 10000 });
  await setVoice({ tts: { connection_id: elevenId, voice: 'v-de' }, stt: { connection_id: deepgramId }, phone: { engine: 'own', transport: 'stream', tts_connection_id: '', stt_connection_id: '' } });
});

describe('choosing the transport', () => {
  it('keeps Twilio\'s voice when the sub-account did not choose its own (the existing behaviour)', async () => {
    await setVoice({ phone: { engine: 'twilio' } });
    const r = await inbound(callSid(1));
    expect(r.text).toContain('<Gather input="speech"');
    expect(r.text).not.toContain('<Connect');
    expect(r.text).toContain('<Say voice="Google.de-DE-Neural2-F"');
  });

  it('answers with a Media Stream tied to this call by a signed token', async () => {
    const sid = callSid(2);
    const r = await inbound(sid);
    expect(r.status).toBe(200);
    expect(r.text).toContain(`<Connect action="http://localhost/hooks/twilio/voice-ai-stream-end/${loc}" method="POST"><Stream url="ws://localhost/hooks/twilio/stream/${loc}"><Parameter name="token" value="`);
    expect(r.text).not.toContain('<Gather');
    expect(session(sid).actions.some((a: any) => a.type === 'voice_transport' && /Live-Stream/.test(a.detail))).toBe(true);
    expect(t.app.db.get<any>('SELECT answered, reason FROM calls WHERE sid = ?', sid)).toMatchObject({ answered: 1, reason: 'ai' });
  });

  it('uses recorded turns when the provider cannot stream or the sub-account asks for them', async () => {
    await setVoice({ phone: { transport: 'turns' } });
    const r = await inbound(callSid(3));
    expect(r.text).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response><Redirect method="POST">http://localhost/hooks/twilio/voice-ai-turn/${loc}?first=1</Redirect></Response>`);
  });

  it('falls back to Twilio\'s voice (and says why on the call) when speech recognition is missing', async () => {
    const solo = (await t.api.post('/api/ai-connections', { provider: 'openai', api_key: 'sk-solo-1234567890', capabilities: ['audio_tts'] })).data.id;
    await setVoice({ stt: { connection_id: '' }, tts: { connection_id: solo } });
    t.app.db.run(`UPDATE ai_connections SET enabled = 0 WHERE id = ?`, deepgramId);
    try {
      const sid = callSid(4);
      const r = await inbound(sid);
      expect(r.text).toContain('<Gather input="speech"');
      expect(session(sid).actions.find((a: any) => a.type === 'voice_fallback').detail).toMatch(/Spracherkennung/);
    } finally {
      t.app.db.run(`UPDATE ai_connections SET enabled = 1 WHERE id = ?`, deepgramId);
      await t.api.del(`/api/ai-connections/${solo}`);
    }
  });

  it('refuses webhooks without a valid Twilio signature', async () => {
    expect((await hook('voice-ai-stream-end', { CallSid: callSid(5) }, { sign: false })).status).toBe(403);
    expect((await hook('voice-ai-turn', { CallSid: callSid(5) }, { query: '?first=1', token: 'e'.repeat(32) })).status).toBe(403);
    expect((await hook('voice-ai-turn-wait', { CallSid: callSid(5) }, { sign: false })).status).toBe(403);
  });
});

describe('Media Stream over a real WebSocket', () => {
  it('speaks the greeting, takes a caller turn, answers, says goodbye and ends the stream with the right TwiML', async () => {
    const sid = callSid(10);
    const twiml = (await inbound(sid)).text;
    const token = /name="token" value="([^"]+)"/.exec(twiml)![1];
    const s = openStream(`/hooks/twilio/stream/${loc}`);
    await s.ready();
    expect(s.state.opened).toBe(true);
    s.start(sid, { token });
    // greeting: three 320-byte chunks of µ-law, then a mark
    await until(() => s.of('mark').length === 1);
    expect(s.audioBytes()).toBe(960);
    expect(streamCalls[0].url).toBe('https://api.elevenlabs.io/v1/text-to-speech/v-de/stream?output_format=ulaw_8000');
    expect(streamCalls[0].body.text).toBe('Guten Tag, Sie sprechen mit dem digitalen Assistenten von Testfirma. Wie kann ich Ihnen helfen?');
    // speech recognition is live (Deepgram over the fake socket) with the key as sub-protocol, µ-law
    await until(() => sttSockets.length === 1);
    expect(sttSockets[0].url).toContain('encoding=mulaw');
    sttSockets[0].open();
    s.echo();
    s.send({ event: 'media', streamSid: STREAM_SID, media: { track: 'inbound', payload: Buffer.alloc(160, 0xff).toString('base64') } });
    await until(() => (sttSockets[0].sent as unknown[]).length >= 1);

    // turn 1
    sttSockets[0].say('Ich möchte einen Termin');
    await until(() => s.of('mark').length === 2);
    expect(claude.at(-1)!.prompt).toContain('Anrufer: Ich möchte einen Termin');
    expect(streamCalls.at(-1)!.body.text).toBe('Gern. Wie ist Ihr Name?');
    s.echo();
    await until(() => turnRows(sid).length === 1);
    expect(turnRows(sid)[0]).toMatchObject({ n: 1, transport: 'stream', interrupted: 0 });
    expect(turnRows(sid)[0].total_ms).toBeGreaterThanOrEqual(0);
    expect(session(sid)).toMatchObject({ turns: 1, status: 'active' });

    // turn 2: the agent ends the call after the goodbye was played
    respond = () => ({ say: 'Auf Wiederhören!', action: 'end_call', args: EMPTY_ARGS });
    sttSockets[0].say('Das war alles, tschüss');
    await until(() => s.of('mark').length === 3);
    expect(s.state.closed).toBeNull();
    s.echo();
    await until(() => s.state.closed !== null);
    expect(s.state.closed!.code).toBe(1000);
    // Twilio now asks what the call does next
    const next = await hook('voice-ai-stream-end', { CallSid: sid });
    expect(next.text).toContain('<Hangup/>');
    expect(next.text).not.toContain('<Say');
    await flush();
    expect(session(sid)).toMatchObject({ status: 'ended', turns: 2, end_reason: 'agent' });
    expect(session(sid).transcript.map((x: any) => x.role)).toEqual(['agent', 'caller', 'agent', 'caller', 'agent']);
    expect(session(sid).actions.some((a: any) => a.type === 'stream_end')).toBe(true);
    expect(t.app.db.get<any>('SELECT status FROM calls WHERE sid = ?', sid)!.status).toBe('completed');
    // the time of each turn is on record
    expect(turnRows(sid).length).toBe(2);
    // a second ask finds nothing stored and ends the call
    expect((await hook('voice-ai-stream-end', { CallSid: sid })).text).toContain('<Hangup/>');
  });

  it('refuses a stream with a wrong, foreign or expired token or for another account – and unknown paths', async () => {
    const sid = callSid(11);
    const twiml = (await inbound(sid)).text;
    const token = /name="token" value="([^"]+)"/.exec(twiml)![1];
    for (const [params, account] of [[{ token: 'nope' }, SID], [{}, SID], [{ token }, `AC${'9'.repeat(32)}`]] as const) {
      const s = openStream(`/hooks/twilio/stream/${loc}`);
      await s.ready();
      s.start(sid, { ...params }, account);
      await until(() => s.state.closed !== null);
      expect(s.state.closed!.code).toBe(1008);
      expect(s.of('media')).toHaveLength(0);
    }
    // the token of another call does not work for this one
    const other = (await inbound(callSid(12))).text;
    const otherToken = /name="token" value="([^"]+)"/.exec(other)![1];
    const s2 = openStream(`/hooks/twilio/stream/${loc}`);
    await s2.ready();
    s2.start(sid, { token: otherToken });
    await until(() => s2.state.closed !== null);
    expect(s2.state.closed!.code).toBe(1008);
    // no session for this call: nothing to carry
    const s3 = openStream(`/hooks/twilio/stream/${loc}`);
    await s3.ready();
    s3.start(callSid(99), { token });
    await until(() => s3.state.closed !== null);
    // unknown sub-account and other paths never become WebSockets
    const bad = openStream('/hooks/twilio/stream/gibtesnicht');
    await bad.ready();
    expect(bad.state.opened).toBe(false);
    const other2 = openStream('/hooks/twilio/anderes');
    await other2.ready();
    expect(other2.state.opened).toBe(false);
    expect(session(sid).status).toBe('active');
  });

  it('carries on with Twilio\'s voice when the own voice fails: the greeting is spoken by Twilio and the agent keeps the call', async () => {
    // a voice nobody used yet: the greeting of the other tests is cached and would play without the provider
    await setVoice({ tts: { voice: 'v-neu' } });
    ttsFail = true;
    const sid = callSid(13);
    const token = /name="token" value="([^"]+)"/.exec((await inbound(sid)).text)![1];
    const s = openStream(`/hooks/twilio/stream/${loc}`);
    await s.ready();
    s.start(sid, { token });
    await until(() => s.state.closed !== null);
    expect(s.state.closed!.code).toBe(1000);
    expect(s.audioBytes()).toBe(0);
    const next = await hook('voice-ai-stream-end', { CallSid: sid });
    expect(next.text).toContain('<Gather input="speech"');
    expect(next.text).toContain('<Say voice="Google.de-DE-Neural2-F" language="de-DE">Guten Tag, Sie sprechen mit dem digitalen Assistenten von Testfirma.');
    expect(session(sid).status).toBe('active');
    expect(session(sid).actions.map((a: any) => a.type)).toEqual(expect.arrayContaining(['tts_error', 'voice_fallback']));
    // and the classic loop works from here
    respond = () => ({ say: 'Gern.', action: 'none', args: EMPTY_ARGS });
    const r = await hook('voice-ai', { CallSid: sid, SpeechResult: 'Hallo' }, { query: '?t=0' });
    expect(r.text).toContain('Gern.');
  });

  it('turns a broken connection into Twilio\'s voice instead of silence', async () => {
    const sid = callSid(14);
    await inbound(sid);
    const r = await hook('voice-ai-stream-end', { CallSid: sid });
    expect(r.text).toContain('<Gather input="speech"');
    expect(session(sid).actions.some((a: any) => a.type === 'voice_fallback' && /Live-Stream/.test(a.detail))).toBe(true);
  });

  it('hangs up the stream when the caller does (no further work, session ends with the call)', async () => {
    const sid = callSid(15);
    const token = /name="token" value="([^"]+)"/.exec((await inbound(sid)).text)![1];
    const s = openStream(`/hooks/twilio/stream/${loc}`);
    await s.ready();
    s.start(sid, { token });
    await until(() => s.of('mark').length === 1);
    s.send({ event: 'stop', streamSid: STREAM_SID, stop: { callSid: sid } });
    await until(() => s.state.closed !== null);
    expect((await hook('voice-ai-stream-end', { CallSid: sid })).text).toContain('<Hangup/>');
    await hook('voice-status', { CallSid: sid, CallStatus: 'completed', CallDuration: '12' });
    await flush();
    expect(session(sid).status).toBe('ended');
    expect(session(sid).end_reason).toBe('caller');
  });
});

describe('recorded turns (record → speech to text → agent → text to speech → play)', () => {
  beforeEach(async () => {
    await setVoice({ phone: { transport: 'turns' } });
  });
  const playUrl = (twiml: string) => /<Play>(http:\/\/localhost\/hooks\/voice\/play\/[\w-]{32}\.mp3)<\/Play>/.exec(twiml)?.[1];
  const rec = (sid: string, c: string, secs = '3', account = SID) => ({ CallSid: sid, RecordingUrl: recUrl(c, account), RecordingSid: `RE${c.repeat(32)}`, RecordingDuration: secs });

  it('plays the greeting and records the next turn; the audio is served once to whoever has the unguessable link', async () => {
    const sid = callSid(20);
    await inbound(sid);
    const g = await hook('voice-ai-turn', { CallSid: sid }, { query: '?first=1' });
    const url = playUrl(g.text)!;
    expect(url).toBeTruthy();
    expect(g.text).toContain(`<Record action="http://localhost/hooks/twilio/voice-ai-turn/${loc}" method="POST" maxLength="30" timeout="2" playBeep="false" trim="trim-silence"/>`);
    const file = await t.api.raw(new URL(url).pathname);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('audio/mpeg');
    expect(file.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(MP3);
    expect(providerCalls.find((c) => c.url.includes('text-to-speech/v-de'))).toBeTruthy();
    expect((await t.api.raw(`/hooks/voice/play/${'a'.repeat(32)}.mp3`)).status).toBe(404);
    expect((await t.api.raw('/hooks/voice/play/..%2F..%2Fetc%2Fpasswd')).status).toBe(404);
    expect((await t.api.raw(`/hooks/voice/play/${'a'.repeat(32)}.exe`)).status).toBe(404);
    // the greeting is the same every call: it is not synthesized again
    const before = providerCalls.filter((c) => c.url.includes('text-to-speech')).length;
    const sid2 = callSid(21);
    await inbound(sid2);
    expect(playUrl((await hook('voice-ai-turn', { CallSid: sid2 }, { query: '?first=1' })).text)).toBeTruthy();
    expect(providerCalls.filter((c) => c.url.includes('text-to-speech')).length).toBe(before);
  });

  it('transcribes the recording with the own provider, asks the agent, answers with <Play> and removes the recording at Twilio', async () => {
    const sid = callSid(22);
    await inbound(sid);
    await hook('voice-ai-turn', { CallSid: sid }, { query: '?first=1' });
    transcript = 'Ich möchte einen Termin am Montag';
    const r = await hook('voice-ai-turn', rec(sid, 'a'));
    expect(r.status).toBe(200);
    expect(playUrl(r.text)).toBeTruthy();
    expect(r.text).toContain('<Record ');
    expect(claude.at(-1)!.prompt).toContain('Anrufer: Ich möchte einen Termin am Montag');
    expect(twilioCalls.map((c) => `${c.method} ${c.url}`)).toEqual(expect.arrayContaining([`GET ${recUrl('a')}.wav`, `DELETE https://api.twilio.com/2010-04-01/Accounts/${SID}/Recordings/RE${'a'.repeat(32)}.json`]));
    const listen = providerCalls.find((c) => c.url.includes('deepgram.com/v1/listen'))!;
    expect(new URL(listen.url).searchParams.get('language')).toBe('de');
    expect(session(sid)).toMatchObject({ turns: 1 });
    expect(session(sid).transcript.at(-1).text).toBe('Gern. Wie ist Ihr Name?');
    expect(turnRows(sid).some((x) => x.transport === 'turns' && x.stt_ms >= 0)).toBe(true);
  });

  it('never fetches recordings of other accounts or from other hosts with our credentials', async () => {
    const sid = callSid(23);
    await inbound(sid);
    for (const params of [rec(sid, 'b', '3', `AC${'9'.repeat(32)}`), { ...rec(sid, 'b'), RecordingUrl: `https://evil.example.com/2010-04-01/Accounts/${SID}/Recordings/RE${'b'.repeat(32)}` }, { ...rec(sid, 'b'), RecordingUrl: 'kein url' }]) {
      const r = await hook('voice-ai-turn', params);
      expect(r.text).toContain('<Gather input="speech"');
    }
    expect(twilioCalls.filter((c) => c.method === 'GET')).toHaveLength(0);
    expect(session(sid).actions.filter((a: any) => a.type === 'stt_error')).toHaveLength(3);
  });

  it('uses Twilio\'s voice for the answer when the own voice fails, and when the recording cannot be fetched', async () => {
    const sid = callSid(24);
    await inbound(sid);
    ttsFail = true;
    const r = await hook('voice-ai-turn', rec(sid, 'c'));
    expect(r.text).toContain('<Gather input="speech"');
    expect(r.text).toContain('Gern. Wie ist Ihr Name?</Say>');
    expect(session(sid).actions.map((a: any) => a.type)).toEqual(expect.arrayContaining(['tts_error', 'voice_fallback']));
    ttsFail = false;
    recordingStatus = 404;
    const sid2 = callSid(25);
    await inbound(sid2);
    const r2 = await hook('voice-ai-turn', rec(sid2, 'd'));
    expect(r2.text).toContain('<Gather input="speech"');
    expect(session(sid2).actions.find((a: any) => a.type === 'stt_error').detail).toMatch(/HTTP 404/);
  });

  it('treats a silent recording like silence: asks, then ends the call politely', async () => {
    const sid = callSid(26);
    await inbound(sid);
    const a = await hook('voice-ai-turn', { CallSid: sid, RecordingDuration: '0' });
    expect(playUrl(a.text)).toBeTruthy();
    expect(session(sid).transcript.at(-1).text).toMatch(/noch da/);
    const b = await hook('voice-ai-turn', { CallSid: sid, RecordingDuration: '0' });
    expect(b.text).toContain('<Play>');
    expect(b.text).toContain('<Hangup/>');
    expect(b.text).not.toContain('<Record');
    await flush();
    expect(session(sid).end_reason).toBe('silence');
  });

  it('says "Einen Moment bitte" when the agent is slow and answers after the redirect', async () => {
    Object.assign(voiceTiming, { replyMs: 40, waitMs: 1500 });
    claudeDelay = 200;
    const sid = callSid(27);
    await inbound(sid);
    const r = await hook('voice-ai-turn', rec(sid, 'e'));
    expect(r.text).toContain('Einen Moment bitte.</Say>');
    expect(r.text).toContain(`<Redirect method="POST">http://localhost/hooks/twilio/voice-ai-turn-wait/${loc}?n=1</Redirect>`);
    const w = await hook('voice-ai-turn-wait', { CallSid: sid }, { query: '?n=1' });
    expect(playUrl(w.text)).toBeTruthy();
    expect(w.text).toContain('<Record ');
    // nothing waiting any more: the call goes on with Twilio's voice
    expect((await hook('voice-ai-turn-wait', { CallSid: sid }, { query: '?n=1' })).text).toContain('<Gather input="speech"');
  });

  it('ends cleanly for calls the agent does not have', async () => {
    expect((await hook('voice-ai-turn', { CallSid: callSid(98) }, { query: '?first=1' })).text).toContain('<Hangup/>');
    expect((await hook('voice-ai-turn-wait', { CallSid: callSid(98) })).text).toContain('<Hangup/>');
  });
});

describe('voicemail with the own speech recognition', () => {
  async function leaveVoicemail(sid: string, rsid: string) {
    await t.api.put('/api/voice-ai/settings', { mode: 'off' });
    await hook('voice', { CallSid: sid, From: '+4917022222', To: TWILIO_NUMBER, CallStatus: 'ringing' });
    await hook('voice-dial', { CallSid: sid, DialCallStatus: 'no-answer' });
    await hook('voice-recording', { CallSid: sid, RecordingSid: rsid, RecordingDuration: '9', RecordingStatus: 'completed' });
    await flush();
    await sleep(30);
    await flush();
  }
  const transcription = (sid: string) => t.app.db.get<any>('SELECT transcription, status FROM calls WHERE sid = ?', sid)!;

  it('transcribes the voicemail and adds a summary when the sub-account wants it', async () => {
    await setVoice({ voicemail_transcribe: true, call_summary: true });
    transcript = 'Hier ist Frau Beispiel, bitte rufen Sie mich wegen eines Termins zurück.';
    const sid = callSid(30);
    await leaveVoicemail(sid, `RE${'f'.repeat(32)}`);
    const c = transcription(sid);
    expect(c.status).toBe('voicemail');
    expect(c.transcription).toContain('Hier ist Frau Beispiel');
    expect(c.transcription).toContain('Zusammenfassung: Frau Beispiel bittet um Rückruf');
    expect(c.transcription).toContain('Nächster Schritt: Heute zurückrufen.');
    expect(twilioCalls.some((x) => x.url === `https://api.twilio.com/2010-04-01/Accounts/${SID}/Recordings/RE${'f'.repeat(32)}.mp3`)).toBe(true);
    // the automatic change is in the audit log
    const call = t.app.db.get<any>('SELECT id FROM calls WHERE sid = ?', sid)!;
    expect(t.app.db.get<any>(`SELECT summary FROM audit_log WHERE action = 'voice.voicemail.transcribe' AND entity_id = ?`, call.id)?.summary).toBe('Voicemail transkribiert und zusammengefasst');
    expect(providerCalls.some((x) => x.url.includes('deepgram.com/v1/listen'))).toBe(true);
  });

  it('only transcribes without a summary when that is all that was asked for, and does nothing when it is off', async () => {
    await setVoice({ voicemail_transcribe: true, call_summary: false });
    transcript = 'Bitte um Rückruf.';
    const sid = callSid(31);
    await leaveVoicemail(sid, `RE${'e'.repeat(32)}`);
    expect(transcription(sid).transcription).toBe('Bitte um Rückruf.');
    await setVoice({ voicemail_transcribe: false, call_summary: false });
    const before = providerCalls.length;
    const sid2 = callSid(32);
    await leaveVoicemail(sid2, `RE${'d'.repeat(32)}`);
    expect(transcription(sid2).transcription).toBe('');
    expect(providerCalls.length).toBe(before);
  });

  it('keeps the voicemail when transcription fails (recording not available)', async () => {
    await setVoice({ voicemail_transcribe: true });
    recordingStatus = 404;
    const sid = callSid(33);
    await leaveVoicemail(sid, `RE${'c'.repeat(32)}`);
    expect(transcription(sid)).toMatchObject({ status: 'voicemail', transcription: '' });
  });
});
