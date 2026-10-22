/**
 * PCM helpers for the realtime voice (Gemini Live, 1.0.54) – pure: the microphone's float samples → 16-bit little-endian PCM at
 * 16 kHz for the server, and the service's 24 kHz PCM back to floats for Web Audio. Shared by companion/realtime.ts and the tests.
 */

/** Float samples (−1…1) → Int16 PCM (clamped). */
export function floatToPcm16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** Little-endian 16-bit PCM bytes → float samples. */
export function pcm16ToFloat(bytes: Uint8Array): Float32Array {
  const n = Math.floor(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

/** Averaging downsampler (e.g. 48 kHz → 16 kHz) for browsers that ignore the AudioContext's requested rate. */
export function downsample(f: Float32Array, from: number, to: number): Float32Array {
  if (to >= from) return f;
  const ratio = from / to;
  const n = Math.floor(f.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(f.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += f[j];
    out[i] = sum / Math.max(1, b - a);
  }
  return out;
}

/** Int16 samples → the bytes sent over the socket (little-endian on every platform). */
export function pcmBytes(s: Int16Array): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < s.length; i++) view.setInt16(i * 2, s[i], true);
  return out;
}
