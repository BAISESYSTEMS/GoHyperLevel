import { createServer } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  FrameSlicer,
  PcmAligner,
  Resampler,
  Vad,
  alawToLinear,
  alawToPcm,
  linearToAlaw,
  linearToUlaw,
  parseWav,
  pcmFromBuffer,
  pcmToAlaw,
  pcmToBuffer,
  pcmToUlaw,
  resample,
  rmsDb,
  ulawMs,
  ulawSilence,
  ulawToLinear,
  ulawToPcm,
  ulawToWav,
  wavFromPcm,
  wavFromUlaw,
  wavTo8k,
  wavToPcm,
  wavToUlaw8k,
} from '../server/services/voice-audio.js';
import { FrameParser, WsProtocolError, acceptKey, acceptWebSocket, encodeFrame, type ServerWs } from '../server/services/voice-ws.js';

/** Pure audio: G.711, resampling, WAV, voice activity, framing – and the WebSocket server endpoint. */

const sine = (hz: number, rate: number, seconds: number, amp = 12000) => Int16Array.from({ length: Math.round(rate * seconds) }, (_, i) => Math.round(amp * Math.sin((2 * Math.PI * hz * i) / rate)));
/** Amplitude of one frequency in a signal (Goertzel). */
function level(pcm: Int16Array, hz: number, rate: number): number {
  const w = (2 * Math.PI * hz) / rate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return (2 * Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2)) / pcm.length;
}

describe('G.711', () => {
  it('matches the reference values', () => {
    expect(linearToUlaw(0)).toBe(0xff);
    expect(ulawToLinear(0xff)).toBe(0);
    expect(ulawToLinear(0x00)).toBe(-32124);
    expect(ulawToLinear(0x80)).toBe(32124);
    expect(linearToUlaw(32767)).toBe(0x80);
    expect(linearToUlaw(-32768)).toBe(0x00);
    expect(alawToLinear(0xd5)).toBe(8);
    expect(linearToAlaw(0)).toBe(0xd5);
  });

  it('decodes every code to a value that encodes back to the same code', () => {
    for (let b = 0; b < 256; b++) {
      expect(ulawToLinear(linearToUlaw(ulawToLinear(b)))).toBe(ulawToLinear(b));
      expect(alawToLinear(linearToAlaw(alawToLinear(b)))).toBe(alawToLinear(b));
    }
    // Only "negative zero" has no own code after the round trip.
    for (let b = 0; b < 256; b++) if (b !== 0x7f) expect(linearToUlaw(ulawToLinear(b))).toBe(b);
  });

  it('keeps the error of a speech-level sine small (round trip PCM → µ-law → PCM)', () => {
    const x = sine(440, 8000, 0.5, 9000);
    for (const [enc, dec] of [
      [pcmToUlaw, ulawToPcm],
      [pcmToAlaw, alawToPcm],
    ] as const) {
      const y = dec(enc(x));
      let worst = 0;
      for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(x[i] - y[i]) / Math.max(256, Math.abs(x[i])));
      expect(worst).toBeLessThan(0.04);
      expect(Math.abs(rmsDb(y) - rmsDb(x))).toBeLessThan(0.3);
    }
  });

  it('turns PCM buffers into samples and back, also for odd and unaligned data', () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
    expect([...pcmFromBuffer(pcmToBuffer(pcm))]).toEqual([...pcm]);
    expect(pcmFromBuffer(Buffer.from([1, 0, 2])).length).toBe(1);
    // A chunk boundary in the middle of a sample must not shift the stream.
    const bytes = pcmToBuffer(pcm);
    const al = new PcmAligner();
    const got = [...al.push(bytes.subarray(0, 3)), ...al.push(bytes.subarray(3, 8)), ...al.push(bytes.subarray(8))];
    expect(got).toEqual([...pcm]);
  });
});

describe('resampling', () => {
  it('keeps a tone at its frequency and amplitude (24 kHz → 8 kHz and 8 kHz → 16 kHz)', () => {
    const down = resample(sine(440, 24000, 1), 24000, 8000);
    expect(down.length).toBe(8000);
    expect(level(down.subarray(400, 7600), 440, 8000)).toBeGreaterThan(11000);
    expect(level(down.subarray(400, 7600), 440, 8000)).toBeLessThan(12500);
    const up = resample(sine(1000, 8000, 1), 8000, 16000);
    expect(up.length).toBe(16000);
    expect(level(up.subarray(800, 15200), 1000, 16000)).toBeGreaterThan(11000);
  });

  it('filters what would alias (a 5 kHz tone at 24 kHz is gone at 8 kHz)', () => {
    const down = resample(sine(5000, 24000, 1), 24000, 8000);
    // Plain decimation would fold 5 kHz down to 3 kHz at nearly full strength.
    expect(level(down.subarray(400, 7600), 3000, 8000)).toBeLessThan(600);
  });

  it('works chunk by chunk like in one go, with odd chunk sizes', () => {
    const x = sine(600, 22050, 0.6);
    const whole = resample(x, 22050, 8000);
    const r = new Resampler(22050, 8000);
    const parts: number[] = [];
    for (let i = 0; i < x.length; ) {
      const n = 97 + (i % 211);
      parts.push(...r.push(x.subarray(i, i + n)));
      i += n;
    }
    parts.push(...r.flush());
    const a = Int16Array.from(parts).subarray(100, whole.length - 100);
    const b = whole.subarray(100, whole.length - 100);
    let worst = 0;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    expect(worst).toBeLessThanOrEqual(2);
    expect(Math.abs(parts.length - whole.length)).toBeLessThan(200);
  });

  it('survives 8 kHz → 24 kHz → 8 kHz and leaves equal rates and empty clips alone', () => {
    const x = sine(500, 8000, 0.5);
    const y = resample(resample(x, 8000, 24000), 24000, 8000);
    expect(y.length).toBe(x.length);
    let worst = 0;
    for (let i = 200; i < x.length - 200; i++) worst = Math.max(worst, Math.abs(x[i] - y[i]));
    expect(worst).toBeLessThan(250);
    expect(resample(x, 8000, 8000)).toBe(x);
    expect(resample(new Int16Array(0), 24000, 8000).length).toBe(0);
    expect(() => new Resampler(0, 8000)).toThrow();
  });
});

describe('WAV', () => {
  it('writes and reads PCM16, µ-law and streamed files', () => {
    const pcm = sine(300, 16000, 0.2);
    const wav = wavFromPcm(pcm, 16000);
    const info = parseWav(wav)!;
    expect(info).toMatchObject({ format: 1, channels: 1, rate: 16000, bits: 16 });
    expect([...wavToPcm(info)]).toEqual([...pcm]);
    // Unknown length (streamed): 0xFFFFFFFF and 0 both mean "until the end".
    for (const size of [0xffffffff, 0]) {
      const streamed = Buffer.from(wav);
      streamed.writeUInt32LE(size, 40);
      expect(parseWav(streamed)!.data.length).toBe(pcm.length * 2);
    }
    const mu = wavFromUlaw(pcmToUlaw(sine(300, 8000, 0.1)));
    expect(parseWav(mu)).toMatchObject({ format: 7, rate: 8000 });
    expect(wavToUlaw8k(mu).length).toBe(800);
    expect(parseWav(Buffer.from('nope'))).toBeNull();
    expect(parseWav(Buffer.from('RIFFxxxxWAVEdata'))).toBeNull();
  });

  it('averages stereo, reads 8/24/32-bit and float, skips extra chunks', () => {
    const stereo = Buffer.alloc(44 + 8);
    wavFromPcm(Int16Array.from([100, 300, -200, -400]), 8000, 2).copy(stereo);
    expect([...wavToPcm(parseWav(stereo)!)]).toEqual([200, -300]);
    const withList = Buffer.concat([wavFromPcm(Int16Array.from([5]), 8000).subarray(0, 36), Buffer.from('LIST'), Buffer.from([3, 0, 0, 0]), Buffer.from('abc\0'), wavFromPcm(Int16Array.from([5]), 8000).subarray(36)]);
    expect(wavToPcm(parseWav(withList)!)[0]).toBe(5);
    const mk = (format: number, bits: number, data: Buffer) => {
      const h = Buffer.alloc(44);
      h.write('RIFF', 0);
      h.writeUInt32LE(36 + data.length, 4);
      h.write('WAVEfmt ', 8);
      h.writeUInt32LE(16, 16);
      h.writeUInt16LE(format, 20);
      h.writeUInt16LE(1, 22);
      h.writeUInt32LE(8000, 24);
      h.writeUInt16LE(bits, 34);
      h.write('data', 36);
      h.writeUInt32LE(data.length, 40);
      return Buffer.concat([h, data]);
    };
    expect(wavToPcm(parseWav(mk(1, 8, Buffer.from([128, 255])))!)[1]).toBe(127 << 8);
    const f32 = Buffer.alloc(4);
    f32.writeFloatLE(0.5);
    expect(wavToPcm(parseWav(mk(3, 32, f32))!)[0]).toBe(16384);
    const i32 = Buffer.alloc(4);
    i32.writeInt32LE(0x40000000);
    expect(wavToPcm(parseWav(mk(1, 32, i32))!)[0]).toBe(16384);
    expect(() => wavToPcm(parseWav(mk(2, 4, Buffer.from([1, 2])))!)).toThrow(/nicht unterstützt/);
  });

  it('converts a TTS file to what telephony needs', () => {
    const wav24 = wavFromPcm(sine(440, 24000, 0.5), 24000);
    const ulaw = wavToUlaw8k(wav24);
    expect(ulaw.length).toBe(4000);
    expect(Math.abs(rmsDb(ulawToPcm(ulaw)) - rmsDb(sine(440, 8000, 0.5)))).toBeLessThan(0.8);
    expect(parseWav(wavTo8k(wav24))).toMatchObject({ format: 1, rate: 8000 });
    expect(() => wavToUlaw8k(Buffer.from('ID3\u0004mp3'))).toThrow(/nicht live abgespielt/);
    // Telephony → STT: µ-law becomes a normal PCM WAV.
    expect(parseWav(ulawToWav(ulawSilence(100)))).toMatchObject({ format: 1, rate: 8000 });
  });
});

describe('voice activity and framing', () => {
  const frame = (amp: number) => sine(300, 8000, 0.02, amp);
  it('reports start after a short run of speech and end after the silence', () => {
    const vad = new Vad({ endMs: 400 });
    const events: string[] = [];
    const feed = (amp: number, frames: number) => {
      for (let i = 0; i < frames; i++) {
        const e = vad.push(frame(amp));
        if (e) events.push(`${e}@${i}`);
      }
    };
    feed(0, 50); // line noise floor
    feed(6000, 3);
    expect(events).toEqual(['start@2']);
    feed(6000, 20);
    feed(0, 25);
    expect(events).toEqual(['start@2', 'end@19']);
    expect(vad.speaking).toBe(false);
  });

  it('ignores clicks and quiet hum, and adapts to a noisy line', () => {
    const vad = new Vad();
    for (let i = 0; i < 40; i++) vad.push(frame(0));
    expect(vad.push(frame(9000))).toBeUndefined(); // 20 ms click
    vad.push(frame(0));
    const hum = new Vad();
    const events: (string | undefined)[] = [];
    for (let i = 0; i < 100; i++) events.push(hum.push(frame(150)));
    expect(events.filter(Boolean)).toEqual([]);
    // A steady noise at −43 dBFS becomes the floor within a minute; speech 12 dB above it still counts.
    const noisy = new Vad({ minDb: -60 });
    for (let i = 0; i < 3000; i++) noisy.push(frame(330));
    expect(noisy.floorDb).toBeGreaterThan(-50);
    expect(noisy.isSpeech(-36)).toBe(false);
    expect(noisy.isSpeech(-20)).toBe(true);
  });

  it('cuts a byte stream into 20 ms frames and pads the last one', () => {
    const s = new FrameSlicer();
    expect(s.push(Buffer.alloc(100, 1))).toHaveLength(0);
    const frames = s.push(Buffer.alloc(300, 2));
    expect(frames.map((f) => f.length)).toEqual([160, 160]);
    expect(frames[0][99]).toBe(1);
    expect(frames[0][100]).toBe(2);
    const last = s.flush();
    expect(last).toHaveLength(1);
    expect(last[0].length).toBe(160);
    expect(last[0][79]).toBe(2);
    expect(last[0][80]).toBe(0xff);
    expect(s.flush()).toEqual([]);
    expect(ulawMs(160)).toBe(20);
    expect(ulawSilence(20).equals(Buffer.alloc(160, 0xff))).toBe(true);
  });
});

/** A masked client frame, as browsers and Twilio send them. */
function clientFrame(opcode: number, payload: Buffer, fin = true, mask = Buffer.from([1, 2, 3, 4])): Buffer {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | len]) : len < 65536 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 127]), Buffer.alloc(8)]);
  if (len >= 65536) head.writeBigUInt64BE(BigInt(len), 2);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, masked]);
}

describe('WebSocket frames', () => {
  it('computes the handshake accept key of RFC 6455', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('parses frames split at any byte, fragmented messages and the 16/64-bit lengths', () => {
    const p = new FrameParser(200_000);
    const wire = Buffer.concat([clientFrame(1, Buffer.from('hallo')), clientFrame(2, Buffer.alloc(300, 7)), clientFrame(1, Buffer.alloc(70_000, 65)), clientFrame(9, Buffer.from('ping'))]);
    const got: any[] = [];
    for (let i = 0; i < wire.length; i += 7) got.push(...p.push(wire.subarray(i, i + 7)));
    expect(got.map((f) => [f.opcode, f.payload.length])).toEqual([
      [1, 5],
      [2, 300],
      [1, 70_000],
      [9, 4],
    ]);
    expect(got[0].payload.toString()).toBe('hallo');
    expect(got[1].payload.every((b: number) => b === 7)).toBe(true);
    const frag = new FrameParser();
    const f2 = [...frag.push(Buffer.concat([clientFrame(1, Buffer.from('ab'), false), clientFrame(0, Buffer.from('cd'), true)]))];
    expect(f2.map((f) => [f.fin, f.opcode])).toEqual([
      [false, 1],
      [true, 0],
    ]);
  });

  it('refuses what a client must never send', () => {
    const code = (b: Buffer, max?: number) => {
      try {
        new FrameParser(max).push(b);
      } catch (e) {
        return (e as WsProtocolError).code;
      }
      return 0;
    };
    expect(code(Buffer.from([0x81, 0x01, 0x41]))).toBe(1002); // unmasked
    expect(code(Buffer.from([0xc1, 0x80, 0, 0, 0, 0]))).toBe(1002); // RSV1
    expect(code(Buffer.from([0x83, 0x80, 0, 0, 0, 0]))).toBe(1002); // unknown opcode
    expect(code(clientFrame(9, Buffer.alloc(126)))).toBe(1002); // control frame too long
    expect(code(clientFrame(8, Buffer.from('x'), false))).toBe(1002); // fragmented control frame
    expect(code(clientFrame(1, Buffer.alloc(300)), 100)).toBe(1009);
    const big = Buffer.concat([Buffer.from([0x81, 0xff]), Buffer.alloc(8), Buffer.alloc(4)]);
    big.writeBigUInt64BE(2n ** 40n, 2);
    expect(code(big, 1024)).toBe(1009);
  });

  it('encodes server frames with the right length fields', () => {
    expect([...encodeFrame(1, Buffer.from('hi'))]).toEqual([0x81, 2, 104, 105]);
    const mid = encodeFrame(2, Buffer.alloc(200));
    expect([...mid.subarray(0, 4)]).toEqual([0x82, 126, 0, 200]);
    const long = encodeFrame(2, Buffer.alloc(70_000));
    expect(long[1]).toBe(127);
    expect(long.readBigUInt64BE(2)).toBe(70_000n);
  });
});

describe('WebSocket server endpoint (real sockets)', () => {
  async function withServer<T>(fn: (port: number, conns: ServerWs[]) => Promise<T>): Promise<T> {
    const conns: ServerWs[] = [];
    const server = createServer((_q, r) => r.writeHead(404).end());
    server.on('upgrade', (req, socket, head) => {
      const ws = acceptWebSocket(req, socket, head, { maxPayload: 4096 });
      if (!ws) return;
      conns.push(ws);
      ws.on('message', (data, binary) => ws.send(binary ? (data as Buffer) : `echo:${data}`));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      return await fn((server.address() as AddressInfo).port, conns);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  it('talks to a standard WebSocket client (text, binary, close)', async () => {
    await withServer(async (port, conns) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/x`);
      ws.binaryType = 'arraybuffer';
      const got: any[] = [];
      ws.onmessage = (e) => got.push(e.data);
      await new Promise<void>((r) => (ws.onopen = () => r()));
      ws.send('hallo');
      ws.send(new Uint8Array([1, 2, 3]));
      await vi_waitFor(() => got.length === 2);
      expect(got[0]).toBe('echo:hallo');
      expect([...new Uint8Array(got[1])]).toEqual([1, 2, 3]);
      const closed = new Promise<number>((r) => (ws.onclose = (e) => r(e.code)));
      ws.close(1000);
      expect(await closed).toBe(1000);
      await vi_waitFor(() => !conns[0].open);
    });
  });

  it('refuses plain HTTP requests, wrong versions and messages above the limit', async () => {
    await withServer(async (port) => {
      const raw = (head: string) =>
        new Promise<string>((resolve) => {
          const s = connect(port, '127.0.0.1', () => s.write(head));
          let out = '';
          s.on('data', (d) => (out += d.toString('latin1')));
          s.on('close', () => resolve(out));
          setTimeout(() => s.destroy(), 1500);
        });
      expect(await raw('GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 8\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n')).toMatch(/^HTTP\/1.1 400/);
      expect(await raw('GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: kurz\r\n\r\n')).toMatch(/^HTTP\/1.1 400/);
      const ws = new WebSocket(`ws://127.0.0.1:${port}/x`);
      await new Promise<void>((r) => (ws.onopen = () => r()));
      const closed = new Promise<number>((r) => (ws.onclose = (e) => r(e.code)));
      ws.send('x'.repeat(5000));
      expect(await closed).toBe(1009);
    });
  });

  it('closes a client that sends unmasked frames', async () => {
    await withServer(async (port) => {
      const out = await new Promise<Buffer>((resolve) => {
        const s = connect(port, '127.0.0.1', () => s.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'));
        const chunks: Buffer[] = [];
        let sent = false;
        s.on('data', (d) => {
          chunks.push(d);
          if (!sent && Buffer.concat(chunks).includes('\r\n\r\n')) {
            sent = true;
            s.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
          }
        });
        s.on('close', () => resolve(Buffer.concat(chunks)));
        setTimeout(() => s.destroy(), 2500);
      });
      const text = out.toString('latin1');
      expect(text).toContain('101 Switching Protocols');
      expect(text).toContain('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
      // a close frame with code 1002 follows the handshake
      const body = out.subarray(out.indexOf('\r\n\r\n') + 4);
      expect(body[0]).toBe(0x88);
      expect(body.readUInt16BE(2)).toBe(1002);
    });
  });
});

async function vi_waitFor(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('Zeitüberschreitung im Test');
    await new Promise((r) => setTimeout(r, 10));
  }
}
