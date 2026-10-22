/**
 * Audio toolkit of the voice layer, pure TypeScript (no ffmpeg, no native modules, no I/O):
 * G.711 µ-law / A-law, PCM16 helpers, band-limited resampling (one-shot and streaming), WAV
 * reading and writing, 20 ms framing and an energy-based voice activity detector.
 *
 * Telephony speaks µ-law at 8 kHz (Twilio Media Streams: base64 payloads of 160 bytes per 20 ms),
 * most TTS engines deliver 16-bit PCM at 16–48 kHz, WAV files or MP3. MP3/Opus can not be decoded
 * here – providers are asked for PCM, µ-law or WAV for live calls and MP3 is only used for files.
 */

// --- G.711 -----------------------------------------------------------------------------------

const ULAW_BIAS = 0x84;

/** ITU-T G.711 µ-law byte → 16-bit linear sample (reference decoder, range ±32124). */
export function ulawToLinear(byte: number): number {
  const u = ~byte & 0xff;
  let t = ((u & 0x0f) << 3) + ULAW_BIAS;
  t <<= (u & 0x70) >> 4;
  return u & 0x80 ? ULAW_BIAS - t : t - ULAW_BIAS;
}

const SEG_UEND = [0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff];
const SEG_AEND = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];
const search = (v: number, table: number[]) => {
  for (let i = 0; i < table.length; i++) if (v <= table[i]) return i;
  return table.length;
};

/** 16-bit linear sample → µ-law byte (reference encoder, 14-bit companding). */
export function linearToUlaw(sample: number): number {
  let pcm = Math.max(-32768, Math.min(32767, Math.round(sample))) >> 2;
  let mask: number;
  if (pcm < 0) {
    pcm = -pcm;
    mask = 0x7f;
  } else mask = 0xff;
  if (pcm > 8159) pcm = 8159;
  pcm += 0x21;
  const seg = search(pcm, SEG_UEND);
  if (seg >= 8) return 0x7f ^ mask;
  return (((seg << 4) | ((pcm >> (seg + 1)) & 0x0f)) ^ mask) & 0xff;
}

/** A-law byte → 16-bit linear sample. */
export function alawToLinear(byte: number): number {
  const a = byte ^ 0x55;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  if (seg === 0) t += 8;
  else {
    t += 0x108;
    if (seg > 1) t <<= seg - 1;
  }
  return a & 0x80 ? t : -t;
}

export function linearToAlaw(sample: number): number {
  let pcm = Math.max(-32768, Math.min(32767, Math.round(sample))) >> 3;
  let mask: number;
  if (pcm >= 0) mask = 0xd5;
  else {
    mask = 0x55;
    pcm = -pcm - 1;
  }
  const seg = search(pcm, SEG_AEND);
  if (seg >= 8) return (0x7f ^ mask) & 0xff;
  const a = (seg << 4) | (seg < 2 ? (pcm >> 1) & 0x0f : (pcm >> seg) & 0x0f);
  return (a ^ mask) & 0xff;
}

const ULAW_DEC = Int16Array.from({ length: 256 }, (_, i) => ulawToLinear(i));
const ALAW_DEC = Int16Array.from({ length: 256 }, (_, i) => alawToLinear(i));
let ulawEnc: Uint8Array | undefined;
let alawEnc: Uint8Array | undefined;
const ulawTable = () => (ulawEnc ??= Uint8Array.from({ length: 65536 }, (_, i) => linearToUlaw(i - 32768)));
const alawTable = () => (alawEnc ??= Uint8Array.from({ length: 65536 }, (_, i) => linearToAlaw(i - 32768)));

export function ulawToPcm(ulaw: Uint8Array): Int16Array {
  const out = new Int16Array(ulaw.length);
  for (let i = 0; i < ulaw.length; i++) out[i] = ULAW_DEC[ulaw[i]];
  return out;
}
export function pcmToUlaw(pcm: Int16Array): Buffer {
  const t = ulawTable();
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = t[pcm[i] + 32768];
  return out;
}
export function alawToPcm(alaw: Uint8Array): Int16Array {
  const out = new Int16Array(alaw.length);
  for (let i = 0; i < alaw.length; i++) out[i] = ALAW_DEC[alaw[i]];
  return out;
}
export function pcmToAlaw(pcm: Int16Array): Buffer {
  const t = alawTable();
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = t[pcm[i] + 32768];
  return out;
}

/** µ-law silence (what Twilio plays when nothing is sent). */
export const ULAW_SILENCE = 0xff;
export const ulawSilence = (ms: number, rate = 8000) => Buffer.alloc(Math.round((ms * rate) / 1000), ULAW_SILENCE);

// --- PCM16 buffers -----------------------------------------------------------------------------

/** Little-endian 16-bit samples of a buffer (a trailing odd byte is ignored; works for unaligned buffers). */
export function pcmFromBuffer(buf: Uint8Array): Int16Array {
  const n = buf.length >> 1;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const v = buf[2 * i] | (buf[2 * i + 1] << 8);
    out[i] = v > 32767 ? v - 65536 : v;
  }
  return out;
}
export function pcmToBuffer(pcm: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) out.writeInt16LE(pcm[i], 2 * i);
  return out;
}

/** Keeps a stream of bytes aligned to whole 16-bit samples across chunk boundaries. */
export class PcmAligner {
  private rest: Buffer = Buffer.alloc(0);
  push(chunk: Uint8Array): Int16Array {
    const buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const whole = buf.length - (buf.length % 2);
    this.rest = Buffer.from(buf.subarray(whole));
    return pcmFromBuffer(buf.subarray(0, whole));
  }
}

// --- resampling ----------------------------------------------------------------------------------

const TABLE_RES = 64;
const kernels = new Map<string, { table: Float32Array; hw: number; fc: number }>();

/** Windowed-sinc low-pass kernel (Blackman window), sampled at 64 points per input sample. */
function kernel(from: number, to: number, zeros = 8) {
  const key = `${from}:${to}:${zeros}`;
  let k = kernels.get(key);
  if (k) return k;
  const fc = Math.min(1, to / from); // cut-off relative to the input Nyquist frequency
  const hw = Math.ceil(zeros / fc); // half width in input samples
  const size = hw * TABLE_RES + 2;
  const table = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const d = i / TABLE_RES;
    const x = fc * d;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const r = Math.min(1, d / hw);
    const win = 0.42 + 0.5 * Math.cos(Math.PI * r) + 0.08 * Math.cos(2 * Math.PI * r);
    table[i] = fc * sinc * win;
  }
  k = { table, hw, fc };
  kernels.set(key, k);
  return k;
}

/** Streaming sample-rate converter (mono PCM16). Output is delayed by half a kernel width; `flush()` drains the tail. */
export class Resampler {
  private readonly table: Float32Array;
  private readonly hw: number;
  private readonly step: number;
  private buf: Float32Array;
  /** Position (in `buf` coordinates) of the next output sample. */
  private t: number;
  constructor(
    readonly from: number,
    readonly to: number,
  ) {
    if (!(from > 0 && to > 0)) throw new Error('Abtastraten müssen positiv sein');
    const k = kernel(from, to);
    this.table = k.table;
    this.hw = k.hw;
    this.step = from / to;
    this.buf = new Float32Array(this.hw);
    this.t = this.hw;
  }

  push(input: Int16Array): Int16Array {
    if (this.from === this.to) return input;
    return this.run(input);
  }

  /** The remaining samples (padded with silence), then the resampler starts over. */
  flush(): Int16Array {
    if (this.from === this.to) return new Int16Array(0);
    const out = this.run(new Int16Array(this.hw + 1));
    this.buf = new Float32Array(this.hw);
    this.t = this.hw;
    return out;
  }

  private run(input: Int16Array): Int16Array {
    const joined = new Float32Array(this.buf.length + input.length);
    joined.set(this.buf);
    for (let i = 0; i < input.length; i++) joined[this.buf.length + i] = input[i];
    this.buf = joined;
    const { hw, table, step } = this;
    const out: number[] = [];
    while (Math.floor(this.t) + hw < this.buf.length) {
      const base = Math.floor(this.t);
      let acc = 0;
      let norm = 0;
      for (let j = base - hw + 1; j <= base + hw; j++) {
        const pos = Math.abs(this.t - j) * TABLE_RES;
        const i0 = Math.floor(pos);
        if (i0 >= table.length - 1) continue;
        const w = table[i0] + (table[i0 + 1] - table[i0]) * (pos - i0);
        acc += this.buf[j] * w;
        norm += w;
      }
      const v = norm > 1e-9 ? acc / norm : 0;
      out.push(v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v));
      this.t += step;
    }
    // Drop what no later output needs.
    const keepFrom = Math.max(0, Math.floor(this.t) - hw);
    if (keepFrom > 0) {
      this.buf = this.buf.slice(keepFrom);
      this.t -= keepFrom;
    }
    return Int16Array.from(out);
  }
}

/** One-shot conversion of a whole clip. */
export function resample(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to || !pcm.length) return pcm;
  const r = new Resampler(from, to);
  const a = r.push(pcm);
  const b = r.flush();
  // The flush pads with silence: only keep as many samples as the clip is long.
  const want = Math.round((pcm.length * to) / from);
  const out = new Int16Array(want);
  out.set(a.subarray(0, Math.min(a.length, want)));
  if (a.length < want) out.set(b.subarray(0, want - a.length), a.length);
  return out;
}

// --- WAV ----------------------------------------------------------------------------------------------

export interface WavInfo {
  /** 1 PCM, 3 float, 6 A-law, 7 µ-law. */
  format: number;
  channels: number;
  rate: number;
  bits: number;
  data: Buffer;
}

/** Parses a RIFF/WAVE file (also streamed ones whose data size is 0 or 0xFFFFFFFF). Returns null for anything else. */
export function parseWav(buf: Buffer): WavInfo | null {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  let format = 0;
  let channels = 1;
  let rate = 0;
  let bits = 16;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4);
    let size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE: the real format code is the start of the sub-format GUID.
      if (format === 0xfffe && size >= 26 && body + 26 <= buf.length) format = buf.readUInt16LE(body + 24);
    } else if (id === 'data') {
      if (!format || !rate) return null;
      if (size === 0 || size === 0xffffffff || body + size > buf.length) size = buf.length - body;
      return { format, channels: Math.max(1, channels), rate, bits, data: buf.subarray(body, body + size) };
    }
    pos = body + size + (size % 2);
  }
  return null;
}

/** Samples of any WAV flavour as mono PCM16 (channels averaged). */
export function wavToPcm(wav: WavInfo): Int16Array {
  const { format, bits, data } = wav;
  let samples: Int16Array;
  if (format === 7) samples = ulawToPcm(data);
  else if (format === 6) samples = alawToPcm(data);
  else if (format === 3 && bits === 32) {
    const n = data.length >> 2;
    samples = new Int16Array(n);
    for (let i = 0; i < n; i++) samples[i] = Math.max(-32768, Math.min(32767, Math.round(data.readFloatLE(4 * i) * 32767)));
  } else if (format === 1 && bits === 16) samples = pcmFromBuffer(data);
  else if (format === 1 && bits === 8) {
    samples = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) samples[i] = (data[i] - 128) << 8;
  } else if (format === 1 && bits === 24) {
    const n = Math.floor(data.length / 3);
    samples = new Int16Array(n);
    for (let i = 0; i < n; i++) samples[i] = data.readIntLE(3 * i, 3) >> 8;
  } else if (format === 1 && bits === 32) {
    const n = data.length >> 2;
    samples = new Int16Array(n);
    for (let i = 0; i < n; i++) samples[i] = data.readInt32LE(4 * i) >> 16;
  } else throw new Error(`WAV-Format nicht unterstützt (Format ${format}, ${bits} Bit)`);
  if (wav.channels <= 1) return samples;
  const frames = Math.floor(samples.length / wav.channels);
  const mono = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < wav.channels; c++) sum += samples[i * wav.channels + c];
    mono[i] = Math.round(sum / wav.channels);
  }
  return mono;
}

/** PCM16 → WAV file (mono by default). */
export function wavFromPcm(pcm: Int16Array, rate: number, channels = 1): Buffer {
  const data = pcmToBuffer(pcm);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** A real µ-law WAV (format 7), what some telephony tools expect. */
export function wavFromUlaw(ulaw: Buffer, rate = 8000): Buffer {
  const h = Buffer.alloc(58);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(50 + ulaw.length, 4);
  h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(18, 16);
  h.writeUInt16LE(7, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate, 28);
  h.writeUInt16LE(1, 32);
  h.writeUInt16LE(8, 34);
  h.writeUInt16LE(0, 36);
  h.write('fact', 38, 'latin1');
  h.writeUInt32LE(4, 42);
  h.writeUInt32LE(ulaw.length, 46);
  h.write('data', 50, 'latin1');
  h.writeUInt32LE(ulaw.length, 54);
  return Buffer.concat([h, ulaw]);
}

/** Telephony audio (µ-law, 8 kHz) → a WAV every speech-to-text API accepts (PCM16). */
export const ulawToWav = (ulaw: Uint8Array, rate = 8000) => wavFromPcm(ulawToPcm(ulaw), rate);

/** Whatever a TTS API returned → µ-law at 8 kHz, if it is a format we can read (WAV). Throws for MP3 etc. */
export function wavToUlaw8k(wavFile: Buffer): Buffer {
  const w = parseWav(wavFile);
  if (!w) throw new Error('Das Audioformat kann nicht live abgespielt werden – bitte WAV/PCM liefern oder die Aufnahme-Runden nutzen');
  if (w.format === 7 && w.rate === 8000 && w.channels === 1) return Buffer.from(w.data);
  return pcmToUlaw(resample(wavToPcm(w), w.rate, 8000));
}

/** Any WAV → 8 kHz PCM16 WAV (what Twilio's <Play> handles without surprises). */
export function wavTo8k(wavFile: Buffer): Buffer {
  const w = parseWav(wavFile);
  if (!w) throw new Error('Keine WAV-Datei');
  return wavFromPcm(resample(wavToPcm(w), w.rate, 8000), 8000);
}

// --- levels and voice activity ---------------------------------------------------------------------

/** RMS level in dBFS (−96 for silence). */
export function rmsDb(pcm: Int16Array): number {
  if (!pcm.length) return -96;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  const rms = Math.sqrt(sum / pcm.length);
  return rms < 1 ? -96 : 20 * Math.log10(rms / 32768);
}

export interface VadOptions {
  /** Sample rate of the frames pushed in (default 8000). */
  rate?: number;
  /** A frame counts as speech this many dB above the noise floor … */
  marginDb?: number;
  /** … and at least this loud (dBFS). */
  minDb?: number;
  /** Consecutive speech time before `start` fires. */
  startMs?: number;
  /** Silence after speech before `end` fires. */
  endMs?: number;
}
export type VadEvent = 'start' | 'end';

/**
 * Energy-based voice activity detection with an adaptive noise floor (falls fast, rises slowly) and
 * hysteresis. Feed it frames of any length that are multiples of ~10 ms; it reports `start` once speech has
 * lasted `startMs` and `end` after `endMs` of silence. Good enough to cut a phone call into
 * utterances and to notice a caller breaking in; not a replacement for a trained model on noisy lines.
 */
export class Vad {
  readonly rate: number;
  private readonly marginDb: number;
  private readonly minDb: number;
  private readonly startMs: number;
  private readonly endMs: number;
  /** Estimated background level (dBFS). */
  floorDb = -55;
  speaking = false;
  private speechMs = 0;
  private silenceMs = 0;
  /** Speech heard since the last silence (ms) – also counted before `start` has fired. */
  runMs = 0;
  lastDb = -96;
  constructor(o: VadOptions = {}) {
    this.rate = o.rate ?? 8000;
    this.marginDb = o.marginDb ?? 12;
    this.minDb = o.minDb ?? -46;
    this.startMs = o.startMs ?? 60;
    this.endMs = o.endMs ?? 700;
  }

  /** True when the frame is louder than the noise floor by the margin. */
  isSpeech(db: number): boolean {
    return db > Math.max(this.floorDb + this.marginDb, this.minDb);
  }

  push(frame: Int16Array): VadEvent | undefined {
    const ms = (frame.length / this.rate) * 1000;
    const db = rmsDb(frame);
    this.lastDb = db;
    const speech = this.isSpeech(db);
    // Noise floor: drops quickly to quiet frames, rises slowly (2 dB/s in pauses, 0.25 dB/s while it hears "speech"),
    // so a steady hum or engine noise is absorbed within a minute while real pauses pull it down at once.
    this.floorDb = db < this.floorDb ? this.floorDb + (db - this.floorDb) * 0.3 : Math.min(this.floorDb + (ms / 1000) * (speech ? 0.25 : 2), db);
    this.floorDb = Math.max(-90, Math.min(-30, this.floorDb));
    this.runMs = speech ? this.runMs + ms : 0;
    if (this.speaking) {
      if (speech) this.silenceMs = 0;
      else {
        this.silenceMs += ms;
        if (this.silenceMs >= this.endMs) {
          this.speaking = false;
          this.speechMs = 0;
          this.silenceMs = 0;
          return 'end';
        }
      }
      return undefined;
    }
    if (speech) {
      this.speechMs += ms;
      if (this.speechMs >= this.startMs) {
        this.speaking = true;
        this.silenceMs = 0;
        return 'start';
      }
    } else this.speechMs = 0;
    return undefined;
  }

  reset() {
    this.speaking = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.runMs = 0;
  }
}

// --- framing ------------------------------------------------------------------------------------------------

/** Cuts a byte stream into frames of a fixed size (160 bytes = 20 ms of 8 kHz µ-law) and keeps the rest. */
export class FrameSlicer {
  private rest: Buffer = Buffer.alloc(0);
  constructor(
    readonly size = 160,
    private readonly pad = ULAW_SILENCE,
  ) {}
  push(chunk: Uint8Array): Buffer[] {
    const buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : Buffer.from(chunk);
    const out: Buffer[] = [];
    let i = 0;
    for (; i + this.size <= buf.length; i += this.size) out.push(buf.subarray(i, i + this.size));
    this.rest = Buffer.from(buf.subarray(i));
    return out;
  }
  /** The last, partial frame padded with silence. */
  flush(): Buffer[] {
    if (!this.rest.length) return [];
    const last = Buffer.alloc(this.size, this.pad);
    this.rest.copy(last);
    this.rest = Buffer.alloc(0);
    return [last];
  }
}

/** Milliseconds of audio in a µ-law buffer at 8 kHz. */
export const ulawMs = (bytes: number, rate = 8000) => (bytes / rate) * 1000;
