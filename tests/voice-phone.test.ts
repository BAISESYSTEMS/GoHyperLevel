import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PhoneSession, phoneTiming, FILLER, type PhoneCall, type StartInfo } from '../server/services/voice-phone.js';
import { pcmToUlaw, ulawSilence } from '../server/services/voice-audio.js';
import type { LiveStt, LiveSttHandlers, PhoneReply, TurnMetrics } from '../server/services/voice-types.js';

/** The phone session of the voice layer driven by a fake socket, fake STT and fake TTS: protocol, turns, barge-in, fallbacks. */

const SID = 'MZ0123456789abcdef0123456789abcdef';
const CALL = 'CA0123456789abcdef0123456789abcdef';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 2000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('Zeitüberschreitung im Test');
    await sleep(5);
  }
};

/** Loud tone (clearly speech for the energy VAD) and silence as µ-law bytes. */
const tone = (ms: number) => pcmToUlaw(Int16Array.from({ length: (ms * 8000) / 1000 }, (_, i) => Math.round(9000 * Math.sin((2 * Math.PI * 300 * i) / 8000))));
const quiet = (ms: number) => ulawSilence(ms);

class FakeWs {
  open = true;
  sent: any[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(d: string | Uint8Array) {
    this.sent.push(JSON.parse(String(d)));
  }
  close(code?: number, reason?: string) {
    this.open = false;
    this.closed = { code, reason };
  }
  of(event: string) {
    return this.sent.filter((m) => m.event === event);
  }
  get audioBytes() {
    return this.of('media').reduce((n, m) => n + Buffer.from(m.media.payload, 'base64').length, 0);
  }
}

class FakeStt implements LiveStt {
  pushed = 0;
  closed = false;
  constructor(readonly h: LiveSttHandlers) {}
  push(b: Buffer) {
    this.pushed += b.length;
  }
  finalize() {}
  close() {
    this.closed = true;
  }
}

interface Rig {
  ws: FakeWs;
  session: PhoneSession;
  call: PhoneCall & { spoken: string[]; timings: TurnMetrics[]; notes: string[]; finished: { next: string | null; why: string }[]; turns: string[]; stts: FakeStt[]; aborted: number; startInfo?: StartInfo };
  script: {
    reply: (speech: string) => PhoneReply | Promise<PhoneReply>;
    chunk: Buffer[];
    ttsDelayMs: number;
    ttsFail: (text: string) => string | null;
    openSttFail: string | null;
    silenceReply: PhoneReply | null;
  };
  /** Twilio side */
  say(event: any): void;
  start(): void;
  media(buf: Buffer): void;
  echoMarks(): void;
}

const listen = (say: string): PhoneReply => ({ say, then: 'listen', twiml: `<Response>gather ${say}</Response>`, next: '' });

function rig(settings: Partial<PhoneCall['settings']> = {}, begin: 'ok' | 'refuse' | 'throw' = 'ok'): Rig {
  const ws = new FakeWs();
  const script: Rig['script'] = { reply: (s) => listen(`Antwort auf ${s}`), chunk: [Buffer.alloc(640, 0x7f), Buffer.alloc(640, 0x7f)], ttsDelayMs: 0, ttsFail: () => null, openSttFail: null, silenceReply: null };
  const call: Rig['call'] = {
    greeting: 'Guten Tag, hier ist der digitale Assistent.',
    maxMs: 60_000,
    settings: { bargeIn: true, filler: true, endpointMs: 700, ...settings },
    spoken: [],
    timings: [],
    notes: [],
    finished: [],
    turns: [],
    stts: [],
    aborted: 0,
    async *tts(text, signal) {
      call.spoken.push(text);
      const fail = script.ttsFail(text);
      if (fail) throw new Error(fail);
      for (const c of script.chunk) {
        if (script.ttsDelayMs) await sleep(script.ttsDelayMs);
        if (signal.aborted) {
          call.aborted++;
          return;
        }
        yield c;
      }
    },
    async openStt(h) {
      if (script.openSttFail) throw new Error(script.openSttFail);
      const s = new FakeStt(h);
      call.stts.push(s);
      return s;
    },
    turn(speech) {
      call.turns.push(speech);
      const r = script.reply(speech);
      return r instanceof Promise ? { job: r } : { reply: r };
    },
    silence: () => script.silenceReply,
    degrade: (line, reason) => ({ say: line, then: 'listen', twiml: `<Response>degraded ${line || '-'} (${reason})</Response>`, next: '' }),
    note: (type, ok, detail) => void call.notes.push(`${type}:${ok}:${detail}`),
    metrics: (m) => void call.timings.push(m),
    finish: (next, why) => void call.finished.push({ next, why }),
  };
  const session = new PhoneSession(ws, {
    begin: async (info) => {
      call.startInfo = info;
      if (begin === 'throw') throw new Error('kaputt');
      return begin === 'ok' ? call : null;
    },
  });
  const r: Rig = {
    ws,
    session,
    call,
    script,
    say: (e) => session.onMessage(JSON.stringify(e)),
    start: () => {
      r.say({ event: 'connected', protocol: 'Call', version: '1.0.0' });
      r.say({ event: 'start', sequenceNumber: '1', streamSid: SID, start: { streamSid: SID, accountSid: 'ACx', callSid: CALL, tracks: ['inbound'], customParameters: { token: 'abc', loc: 'L1' }, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } });
    },
    media: (buf) => {
      for (let i = 0; i < buf.length; i += 160) r.say({ event: 'media', streamSid: SID, media: { track: 'inbound', chunk: '1', timestamp: '0', payload: buf.subarray(i, i + 160).toString('base64') } });
    },
    echoMarks: () => {
      for (const m of ws.of('mark')) r.say({ event: 'mark', streamSid: SID, mark: { name: m.mark.name } });
    },
  };
  return r;
}

const saved = { ...phoneTiming };
beforeEach(() => Object.assign(phoneTiming, { startMs: 300, fillerMs: 60, silenceMs: 120, markExtraMs: 150, bargeStartMs: 100, bargeGraceMs: 20, commitMs: 60, quietMs: 100 }));
afterEach(() => Object.assign(phoneTiming, saved));

describe('Media Streams protocol', () => {
  it('authorises on start, speaks the greeting in 20 ms frames and waits for the mark', async () => {
    const r = rig();
    r.start();
    await until(() => r.ws.of('mark').length === 1);
    expect(r.call.startInfo).toMatchObject({ streamSid: SID, callSid: CALL, params: { token: 'abc', loc: 'L1' } });
    expect(r.call.spoken).toEqual([r.call.greeting]);
    const media = r.ws.of('media');
    expect(media.length).toBeGreaterThan(0);
    for (const m of media) {
      expect(m.streamSid).toBe(SID);
      expect(Buffer.from(m.media.payload, 'base64').length % 160).toBe(0);
    }
    expect(r.ws.audioBytes).toBe(1280);
    expect(r.ws.of('mark')[0]).toMatchObject({ streamSid: SID, mark: { name: expect.stringMatching(/^u\d+$/) } });
    r.echoMarks();
    await sleep(20);
    expect(r.call.finished).toEqual([]);
    expect(r.ws.closed).toBeNull();
  });

  it('pads a last partial frame with silence and never sends odd sizes', async () => {
    const r = rig();
    r.script.chunk = [Buffer.alloc(250, 0x10), Buffer.alloc(100, 0x20)];
    r.start();
    await until(() => r.ws.of('mark').length === 1);
    expect(r.ws.audioBytes).toBe(480);
    const last = Buffer.from(r.ws.of('media').at(-1).media.payload, 'base64');
    expect(last.subarray(-10).every((b) => b === 0xff)).toBe(true);
  });

  it('ignores garbage, binary frames, other tracks and media before the start', async () => {
    const r = rig();
    r.session.onMessage('kein json');
    r.session.onMessage(Buffer.from([1, 2, 3]), true);
    r.media(tone(40));
    r.say({ event: 'media', media: { track: 'outbound', payload: 'AAAA' } });
    r.say({ event: 'unbekannt' });
    r.say(null);
    expect(r.ws.sent).toEqual([]);
    expect(r.ws.closed).toBeNull();
    r.start();
    await until(() => r.call.stts.length === 1);
    r.say({ event: 'media', streamSid: SID, media: { track: 'outbound', payload: Buffer.alloc(160).toString('base64') } });
    r.say({ event: 'media', streamSid: SID, media: { payload: 12 } });
    await sleep(10);
    expect(r.call.stts[0].pushed).toBe(0);
  });

  it('feeds the caller\'s audio to the recognizer, including frames that arrived while the call was still being authorised', async () => {
    const r = rig();
    r.start();
    r.media(tone(60)); // before begin() resolved
    await until(() => r.call.stts.length === 1);
    expect(r.call.stts[0].pushed).toBe(480);
    r.media(quiet(40));
    expect(r.call.stts[0].pushed).toBe(800);
  });

  it('refuses a stream that is not authorised or whose start fails', async () => {
    const a = rig({}, 'refuse');
    a.start();
    await until(() => a.ws.closed !== null);
    expect(a.ws.closed?.code).toBe(1008);
    expect(a.call.stts).toHaveLength(0);
    const b = rig({}, 'throw');
    b.start();
    await until(() => b.ws.closed !== null);
    expect(b.ws.closed?.code).toBe(1011);
    const c = rig();
    c.say({ event: 'start', start: { streamSid: '../x', callSid: CALL } });
    expect(c.ws.closed?.code).toBe(1008);
    const d = rig();
    d.say({ event: 'start', start: { streamSid: SID } });
    expect(d.ws.closed?.code).toBe(1008);
  });

  it('tells the module the call is over when the socket closed while the call was being authorised', async () => {
    const ws = new FakeWs();
    const done: string[] = [];
    const call = rig().call;
    call.finish = (next, why) => void done.push(`${why}:${next}`);
    const session = new PhoneSession(ws, { begin: async () => (await sleep(30), call) });
    session.onMessage(JSON.stringify({ event: 'start', start: { streamSid: SID, callSid: CALL } }));
    session.onMessage(JSON.stringify({ event: 'stop' }));
    await until(() => done.length > 0);
    await sleep(20);
    expect(done).toEqual(['caller:null']);
    expect(call.spoken).toEqual([]);
  });

  it('closes a socket that never sends start', async () => {
    const r = rig();
    await until(() => r.ws.closed !== null, 1000);
    expect(r.ws.closed?.code).toBe(1008);
    expect(r.call.finished).toEqual([]);
  });

  it('ends cleanly when the caller hangs up (stop event or closed socket)', async () => {
    const r = rig();
    r.start();
    await until(() => r.ws.of('mark').length === 1);
    r.say({ event: 'stop', stop: { callSid: CALL } });
    expect(r.call.finished).toEqual([{ next: null, why: 'caller' }]);
    expect(r.call.stts[0].closed).toBe(true);
    expect(r.ws.closed?.code).toBe(1000);
    // a second signal changes nothing
    r.session.onClose();
    expect(r.call.finished).toHaveLength(1);
    const q = rig();
    q.start();
    await until(() => q.call.stts.length === 1);
    q.session.onClose();
    expect(q.call.finished).toEqual([{ next: null, why: 'caller' }]);
  });
});

describe('turns', () => {
  async function live(settings: Partial<PhoneCall['settings']> = {}) {
    const r = rig(settings);
    r.start();
    await until(() => r.ws.of('mark').length === 1);
    r.echoMarks();
    await sleep(10);
    return r;
  }
  const marks = (r: Rig) => r.ws.of('mark').length;

  it('answers a caller turn with the agent\'s reply and measures the latency', async () => {
    const r = await live();
    const stt = r.call.stts[0];
    r.media(tone(200));
    stt.h.onFinal('Ich möchte einen Termin', { speechFinal: true });
    await until(() => marks(r) === 2);
    expect(r.call.turns).toEqual(['Ich möchte einen Termin']);
    expect(r.call.spoken.at(-1)).toBe('Antwort auf Ich möchte einen Termin');
    r.echoMarks();
    await until(() => r.call.timings.length === 1);
    expect(r.call.timings[0].n).toBe(1);
    expect(r.call.timings[0].interrupted).toBeUndefined();
    for (const k of ['stt_ms', 'llm_ms', 'tts_ms', 'total_ms'] as const) expect(r.call.timings[0][k], k).toBeGreaterThanOrEqual(0);
    expect(r.call.timings[0].total_ms!).toBeGreaterThanOrEqual(r.call.timings[0].tts_ms!);
    r.echoMarks();
    await sleep(10);
    expect(r.call.finished).toEqual([]);
  });

  it('puts partial final transcripts together and commits after a pause when the provider sends no end-of-speech', async () => {
    const r = await live();
    const stt = r.call.stts[0];
    stt.h.onFinal('Ich hätte gern', { speechFinal: false });
    stt.h.onFinal('einen Termin am Montag', { speechFinal: false });
    await until(() => r.call.turns.length === 1);
    expect(r.call.turns[0]).toBe('Ich hätte gern einen Termin am Montag');
  });

  it('keeps what is said while the agent still thinks and answers it afterwards', async () => {
    const r = await live();
    let release: (v: PhoneReply) => void = () => undefined;
    r.script.reply = (s) => (s === 'erste Frage' ? new Promise<PhoneReply>((res) => (release = res)) : listen(`Antwort auf ${s}`));
    const stt = r.call.stts[0];
    stt.h.onFinal('erste Frage', { speechFinal: true });
    await until(() => r.call.turns.length === 1);
    stt.h.onFinal('und noch etwas', { speechFinal: true });
    stt.h.onFinal('dazu', { speechFinal: true });
    await sleep(20);
    expect(r.call.turns).toEqual(['erste Frage']);
    release(listen('Antwort eins'));
    await until(() => r.call.turns.length === 2);
    expect(r.call.turns[1]).toBe('und noch etwas dazu');
  });

  it('says "Einen Moment bitte" once when the agent is slow, before the answer', async () => {
    const r = await live();
    r.script.reply = () => new Promise<PhoneReply>((res) => setTimeout(() => res(listen('Fertig.')), 220));
    r.call.stts[0].h.onFinal('Frage', { speechFinal: true });
    await until(() => r.call.spoken.includes('Fertig.'));
    expect(r.call.spoken.filter((t) => t === FILLER)).toHaveLength(1);
    expect(r.call.spoken.indexOf(FILLER)).toBeLessThan(r.call.spoken.indexOf('Fertig.'));
    // no filler when the answer is quick
    const q = await live();
    q.call.stts[0].h.onFinal('Frage', { speechFinal: true });
    await until(() => q.call.spoken.length === 2);
    expect(q.call.spoken).not.toContain(FILLER);
  });

  it('asks "are you still there" after a silence, using the brain\'s line', async () => {
    const r = await live();
    r.script.silenceReply = listen('Sind Sie noch da?');
    await until(() => r.call.spoken.includes('Sind Sie noch da?'));
    // no silence prompt while the caller talks
    const q = await live();
    q.script.silenceReply = listen('Hallo?');
    const stop = Date.now() + 250;
    while (Date.now() < stop) {
      q.media(tone(20));
      await sleep(10);
    }
    expect(q.call.spoken).not.toContain('Hallo?');
  });

  it('hangs up after the goodbye was played: the stream ends with the brain\'s TwiML', async () => {
    const r = await live();
    r.script.reply = () => ({ say: 'Auf Wiederhören!', then: 'hangup', twiml: '<Response>say+hangup</Response>', next: '<Response><Hangup/></Response>' });
    r.call.stts[0].h.onFinal('Das war alles', { speechFinal: true });
    await until(() => marks(r) === 2);
    expect(r.call.finished).toEqual([]);
    r.echoMarks();
    await until(() => r.call.finished.length === 1);
    expect(r.call.finished[0]).toEqual({ next: '<Response><Hangup/></Response>', why: 'hangup' });
    expect(r.ws.closed?.code).toBe(1000);
    expect(r.call.stts[0].closed).toBe(true);
  });

  it('transfers and voicemails with the TwiML the brain prepared', async () => {
    for (const then of ['transfer', 'voicemail'] as const) {
      const r = await live();
      r.script.reply = () => ({ say: 'Ich verbinde Sie.', then, twiml: '<Response>full</Response>', next: `<Response>${then}</Response>` });
      r.call.stts[0].h.onFinal('Bitte verbinden', { speechFinal: true });
      await until(() => marks(r) === 2);
      r.echoMarks();
      await until(() => r.call.finished.length === 1);
      expect(r.call.finished[0]).toEqual({ next: `<Response>${then}</Response>`, why: then });
    }
  });

  it('ends the call even if Twilio never confirms the last mark', async () => {
    const r = await live();
    r.script.reply = () => ({ say: 'Tschüss', then: 'hangup', twiml: '', next: '<Response><Hangup/></Response>' });
    r.call.stts[0].h.onFinal('Ende', { speechFinal: true });
    await until(() => r.call.finished.length === 1, 3000);
    expect(r.call.finished[0].why).toBe('hangup');
  });
});

describe('barge-in', () => {
  async function talking(settings: Partial<PhoneCall['settings']> = {}) {
    const r = rig(settings);
    r.start();
    await until(() => r.ws.of('mark').length === 1);
    r.echoMarks();
    await sleep(10);
    // a long answer that is still being produced when the caller breaks in
    r.script.chunk = Array.from({ length: 20 }, () => Buffer.alloc(320, 0x7f));
    r.script.ttsDelayMs = 25;
    r.call.stts[0].h.onFinal('Erzähl mir alles', { speechFinal: true });
    await until(() => r.call.spoken.length === 2 && r.ws.of('media').length > 3);
    return r;
  }

  it('stops the agent at once when the caller talks: clear, aborted request, the caller\'s turn is taken', async () => {
    const r = await talking();
    const before = r.ws.audioBytes;
    for (let i = 0; i < 10; i++) {
      r.media(tone(20));
      await sleep(5);
    }
    await until(() => r.ws.of('clear').length === 1);
    await until(() => r.call.aborted === 1);
    expect(r.ws.audioBytes).toBeLessThan(before + 20 * 320);
    // the new utterance becomes the next turn
    r.call.stts[0].h.onFinal('Moment, anderes Thema', { speechFinal: true });
    await until(() => r.call.turns.length === 2);
    expect(r.call.turns[1]).toBe('Moment, anderes Thema');
    await until(() => r.call.timings.length >= 1);
    expect(r.call.timings[0].interrupted).toBe(true);
    expect(r.ws.of('mark').filter((m) => m.mark.name === 'u2')).toHaveLength(0);
  });

  it('also reacts to a recognised word (partial transcript) and to a final transcript', async () => {
    const r = await talking();
    r.call.stts[0].h.onPartial?.('Mo');
    await sleep(30);
    expect(r.ws.of('clear')).toHaveLength(0); // too short to count
    r.call.stts[0].h.onPartial?.('Moment bitte');
    await until(() => r.ws.of('clear').length === 1);
  });

  it('is off when the sub-account turned it off: the agent finishes and the caller\'s words over it are dropped', async () => {
    const r = await talking({ bargeIn: false });
    for (let i = 0; i < 12; i++) {
      r.media(tone(20));
      await sleep(5);
    }
    r.call.stts[0].h.onFinal('Hallo hören Sie mich', { speechFinal: true });
    await sleep(60);
    expect(r.ws.of('clear')).toHaveLength(0);
    expect(r.call.aborted).toBe(0);
    await until(() => r.ws.of('mark').length === 2, 3000);
    await sleep(30);
    expect(r.call.turns).toEqual(['Erzähl mir alles']);
  });

  it('does not cut the agent off for speech right at its start (grace period) or for quiet noise', async () => {
    phoneTiming.bargeGraceMs = 5000;
    const r = await talking();
    for (let i = 0; i < 12; i++) {
      r.media(tone(20));
      await sleep(5);
    }
    expect(r.ws.of('clear')).toHaveLength(0);
    phoneTiming.bargeGraceMs = 20;
    const q = await talking();
    q.media(quiet(400));
    await sleep(30);
    expect(q.ws.of('clear')).toHaveLength(0);
  });
});

describe('provider trouble: Twilio\'s own voice takes over', () => {
  it('falls back with the line that should have been spoken when the TTS fails', async () => {
    const r = rig();
    r.start();
    await until(() => r.ws.of('mark').length === 1);
    r.echoMarks();
    await sleep(10);
    r.script.ttsFail = (t) => (t.startsWith('Antwort') ? 'ElevenLabs: Guthaben aufgebraucht (HTTP 402)' : null);
    r.call.stts[0].h.onFinal('Hallo', { speechFinal: true });
    await until(() => r.call.finished.length === 1);
    expect(r.call.finished[0].why).toBe('fallback');
    expect(r.call.finished[0].next).toContain('degraded Antwort auf Hallo');
    expect(r.call.finished[0].next).toContain('Sprachausgabe: ElevenLabs');
    expect(r.call.notes.some((n) => n.startsWith('tts_error:false:ElevenLabs'))).toBe(true);
    expect(r.ws.closed?.code).toBe(1000);
    // what was already queued at Twilio is cleared
    expect(r.ws.of('clear')).toHaveLength(1);
  });

  it('speaks the farewell with Twilio\'s voice when the TTS fails on a hang-up line', async () => {
    const r = rig();
    r.start();
    await until(() => r.ws.of('mark').length === 1);
    r.echoMarks();
    r.script.ttsFail = (t) => (t === 'Tschüss' ? 'kaputt' : null);
    r.script.reply = () => ({ say: 'Tschüss', then: 'hangup', twiml: '<Response>say Tschüss+hangup</Response>', next: '<Response><Hangup/></Response>' });
    r.call.stts[0].h.onFinal('Ende', { speechFinal: true });
    await until(() => r.call.finished.length === 1);
    expect(r.call.finished[0]).toEqual({ next: '<Response>say Tschüss+hangup</Response>', why: 'hangup-fallback' });
  });

  it('falls back with the greeting when the recognizer cannot be opened', async () => {
    const r = rig();
    r.script.openSttFail = 'Deepgram: Schlüssel prüfen (HTTP 401)';
    r.start();
    await until(() => r.call.finished.length === 1);
    expect(r.call.finished[0].next).toContain(`degraded ${r.call.greeting}`);
    expect(r.call.spoken).toEqual([]);
    expect(r.ws.closed?.code).toBe(1000);
  });

  it('reconnects a recognizer that dropped (retryable), then falls back when it keeps failing', async () => {
    const r = rig();
    r.start();
    await until(() => r.ws.of('mark').length === 1);
    r.echoMarks();
    const err = (msg: string, retryable: boolean) => Object.assign(new Error(msg), { retryable });
    r.call.stts[0].h.onError(err('Deepgram: Verbindung beendet (1011)', true));
    await until(() => r.call.stts.length === 2);
    expect(r.call.stts[0].closed).toBe(true);
    expect(r.call.finished).toEqual([]);
    r.call.stts[1].h.onError(err('Deepgram: Verbindung beendet (1011)', true));
    await until(() => r.call.stts.length === 3);
    r.call.stts[2].h.onError(err('Deepgram: Verbindung beendet (1011)', true));
    await until(() => r.call.finished.length === 1);
    expect(r.call.finished[0].next).toContain('Spracherkennung: Deepgram');
    // a permanent error falls back at once
    const q = rig();
    q.start();
    await until(() => q.ws.of('mark').length === 1);
    q.call.stts[0].h.onError(err('Deepgram: Schlüssel ungültig', false));
    await until(() => q.call.finished.length === 1);
    expect(q.call.stts).toHaveLength(1);
  });

  it('falls back when the brain gives no answer', async () => {
    const r = rig();
    r.start();
    await until(() => r.ws.of('mark').length === 1);
    r.echoMarks();
    r.script.reply = () => Promise.reject(new Error('Absturz'));
    r.call.stts[0].h.onFinal('Hallo', { speechFinal: true });
    await until(() => r.call.finished.length === 1);
    expect(r.call.finished[0].why).toBe('fallback');
    expect(r.call.notes.some((n) => n.startsWith('turn_error:false:Absturz'))).toBe(true);
  });
});

describe('limits', () => {
  it('hangs up when the call outlasts its maximum duration', async () => {
    const ws = new FakeWs();
    const finished: string[] = [];
    const call = rig().call;
    call.maxMs = -29_950; // + 30 s grace → 50 ms
    call.finish = (next, why) => void finished.push(`${why}:${next}`);
    const session = new PhoneSession(ws, { begin: async () => call });
    session.onMessage(JSON.stringify({ event: 'start', start: { streamSid: SID, callSid: CALL } }));
    await until(() => finished.length === 1);
    expect(finished[0]).toMatch(/^limit:.*<Hangup\/>/);
    expect(ws.closed?.code).toBe(1000);
  });
});
