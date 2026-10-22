import { parseWav, wavFromPcm } from './voice-audio.js';

/**
 * Audio files of the telephony: greetings of the menu, hold music, voicemail drops. Pure helpers – the type check
 * (Twilio's <Play> takes MP3 and WAV), a duration estimate and the built-in hold melody.
 */

export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
export const AUDIO_KINDS = ['greeting', 'hold', 'drop'] as const;
export type AudioKind = (typeof AUDIO_KINDS)[number];
export const AUDIO_KIND_LABEL: Record<AudioKind, string> = { greeting: 'Ansage', hold: 'Wartemusik', drop: 'Voicemail-Drop' };

/** What <Play> can play: the types we accept. */
export const PLAYABLE: Record<string, string> = { 'audio/mpeg': '.mp3', 'audio/wav': '.wav' };

// MPEG-1 Layer III bitrates (kbit/s) and sample rates; MPEG-2/2.5 Layer III bitrates.
const BR_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BR_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];

/** Length of an MP3 in seconds, estimated from the first frame (exact for constant bitrate). 0 when it cannot be read. */
export function mp3Seconds(buf: Buffer): number {
  let pos = 0;
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') pos = 10 + ((buf[6] & 0x7f) << 21) + ((buf[7] & 0x7f) << 14) + ((buf[8] & 0x7f) << 7) + (buf[9] & 0x7f);
  for (let i = pos; i < Math.min(buf.length - 4, pos + 4096); i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (buf[i + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = 2.5
    const layer = (buf[i + 1] >> 1) & 3; // 1 = Layer III
    const bitrateIndex = (buf[i + 2] >> 4) & 15;
    if (version === 1 || layer !== 1 || !bitrateIndex || bitrateIndex === 15) continue;
    const kbps = (version === 3 ? BR_V1 : BR_V2)[bitrateIndex];
    if (!kbps) continue;
    return Math.round(((buf.length - i) * 8) / (kbps * 1000));
  }
  return 0;
}

/** Length of a playable file in seconds (0 = unknown). */
export function audioSeconds(buf: Buffer, mime: string): number {
  if (mime === 'audio/wav') {
    const w = parseWav(buf);
    if (!w) return 0;
    const bytesPerSecond = w.rate * w.channels * Math.max(1, w.bits / 8);
    return bytesPerSecond ? Math.round(w.data.length / bytesPerSecond) : 0;
  }
  return mp3Seconds(buf);
}

let melody: Buffer | undefined;
/**
 * The built-in hold music: a soft pentatonic arpeggio, 16 seconds of telephone-quality WAV (8 kHz), made here so there is
 * nothing to license and nothing to download. Each hold segment of a queue plays it once.
 */
export function holdMelody(): Buffer {
  if (melody) return melody;
  const rate = 8000;
  // A-minor pentatonic over two octaves; each note rings for 0.5 s with a gentle attack and a long decay.
  const notes = [220, 261.63, 293.66, 329.63, 392, 440, 392, 329.63, 293.66, 261.63, 220, 196, 220, 329.63, 440, 392];
  const noteLen = Math.round(rate * 0.5);
  const pcm = new Int16Array(notes.length * 2 * noteLen);
  for (let n = 0; n < notes.length * 2; n++) {
    const f = notes[n % notes.length];
    for (let i = 0; i < noteLen; i++) {
      const t = i / rate;
      const env = Math.min(1, i / 120) * Math.exp(-3.2 * t);
      const s = Math.sin(2 * Math.PI * f * t) * 0.7 + Math.sin(2 * Math.PI * f * 2 * t) * 0.2 + Math.sin(2 * Math.PI * f * 3 * t) * 0.08;
      const at = n * noteLen + i;
      pcm[at] = Math.round(s * env * 9000);
    }
  }
  melody = wavFromPcm(pcm, rate);
  return melody;
}
