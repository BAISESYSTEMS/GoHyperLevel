import { bad, num, str } from '../core/http.js';
import { MODEL_RE } from './ai-presets.js';

/**
 * Voice settings per sub-account (defaults for text to speech and speech to text, the phone agent's engine,
 * defaults of the HyperLevel Agent panel, voicemail and call summaries) and per-user preferences of the panel.
 * Which provider is used comes from the BYOK registry's routing ("Sprachausgabe" / "Transkription"); the
 * connection ids here are optional overrides per use.
 */

export const PHONE_ENGINES = ['twilio', 'own'] as const;
export const PHONE_TRANSPORTS = ['auto', 'stream', 'turns'] as const;

export interface VoiceSettings {
  tts: { connection_id: string; model: string; voice: string; language: string; speed: number; instructions: string };
  stt: { connection_id: string; model: string; language: string };
  phone: {
    /** "Stimme & Spracherkennung": Twilio's own (default) or the sub-account's provider. */
    engine: (typeof PHONE_ENGINES)[number];
    /** own provider: live stream (Twilio Media Streams), recorded turns (<Record> → <Play>) or automatic. */
    transport: (typeof PHONE_TRANSPORTS)[number];
    tts_connection_id: string;
    tts_model: string;
    tts_voice: string;
    stt_connection_id: string;
    stt_model: string;
    /** ElevenLabs: WebSocket instead of chunked HTTP. */
    tts_ws: boolean;
    /** Silence that ends a caller's turn (ms). */
    endpoint_ms: number;
    /** The caller may interrupt the agent. */
    barge_in: boolean;
    /** Say "Einen Moment bitte" when the answer takes long. */
    filler: boolean;
  };
  agent: { read_aloud: boolean; auto_send: boolean };
  voicemail_transcribe: boolean;
  call_summary: boolean;
}

export function defaultVoiceSettings(): VoiceSettings {
  return {
    tts: { connection_id: '', model: '', voice: '', language: 'de', speed: 1, instructions: '' },
    stt: { connection_id: '', model: '', language: 'de' },
    phone: { engine: 'twilio', transport: 'auto', tts_connection_id: '', tts_model: '', tts_voice: '', stt_connection_id: '', stt_model: '', tts_ws: false, endpoint_ms: 700, barge_in: true, filler: true },
    agent: { read_aloud: false, auto_send: false },
    voicemail_transcribe: false,
    call_summary: false,
  };
}

const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});

/** Stored JSON over the defaults (unknown keys dropped, wrong types replaced by the default). */
export function withVoiceDefaults(stored: unknown): VoiceSettings {
  const d = defaultVoiceSettings();
  const s = obj(stored);
  const pick = <T extends Record<string, any>>(def: T, v: unknown): T => {
    const o = obj(v);
    return Object.fromEntries(Object.entries(def).map(([k, dv]) => [k, typeof o[k] === typeof dv ? o[k] : dv])) as T;
  };
  const out: VoiceSettings = { tts: pick(d.tts, s.tts), stt: pick(d.stt, s.stt), phone: pick(d.phone, s.phone), agent: pick(d.agent, s.agent), voicemail_transcribe: s.voicemail_transcribe === true, call_summary: s.call_summary === true };
  if (!PHONE_ENGINES.includes(out.phone.engine)) out.phone.engine = 'twilio';
  if (!PHONE_TRANSPORTS.includes(out.phone.transport)) out.phone.transport = 'auto';
  return out;
}

const bool = (v: unknown) => v === true || v === 'true' || v === 1;
const id = (v: unknown, field: string) => str(v, field, { max: 120 });
const modelId = (v: unknown, field: string) => {
  const m = str(v, field, { max: 160 });
  if (m && !MODEL_RE.test(m)) throw bad(`${field}: bitte die Modell-ID des Anbieters (Buchstaben, Ziffern, . _ - : / @ +).`);
  return m;
};
/** Voice ids as providers write them (letters, digits, spaces, . _ - : ' ( ) / @ +). */
export const VOICE_RE = /^[\p{L}\p{N} _.:'()/@+-]{1,120}$/u;
const voiceId = (v: unknown, field: string) => {
  const s = str(v, field, { max: 120 });
  if (s && !VOICE_RE.test(s)) throw bad(`${field}: ungültige Zeichen`);
  return s;
};
export const LANG_RE = /^[a-z]{2,3}([-_][A-Za-z]{2,4})?$/;
const lang = (v: unknown, field: string) => {
  const s = str(v, field, { max: 12 });
  if (s && !LANG_RE.test(s)) throw bad(`${field}: bitte ein Sprachkürzel wie de oder de-DE`);
  return s || 'de';
};

/** Validates a settings patch from the browser; connection ids are checked by the module against the registry. */
export function cleanVoiceSettings(b: any, cur: VoiceSettings): VoiceSettings {
  const out: VoiceSettings = JSON.parse(JSON.stringify(cur));
  const t = obj(b.tts);
  if (t.connection_id !== undefined) out.tts.connection_id = id(t.connection_id, 'Verbindung Sprachausgabe');
  if (t.model !== undefined) out.tts.model = modelId(t.model, 'Modell Sprachausgabe');
  if (t.voice !== undefined) out.tts.voice = voiceId(t.voice, 'Stimme');
  if (t.language !== undefined) out.tts.language = lang(t.language, 'Sprache');
  if (t.speed !== undefined) {
    const v = num(t.speed, NaN);
    if (!Number.isFinite(v) || v < 0.5 || v > 2) throw bad('Sprechtempo: 0,5 bis 2');
    out.tts.speed = Math.round(v * 100) / 100;
  }
  if (t.instructions !== undefined) out.tts.instructions = str(t.instructions, 'Stil-Anweisung', { max: 500 });
  const s = obj(b.stt);
  if (s.connection_id !== undefined) out.stt.connection_id = id(s.connection_id, 'Verbindung Spracherkennung');
  if (s.model !== undefined) out.stt.model = modelId(s.model, 'Modell Spracherkennung');
  if (s.language !== undefined) out.stt.language = lang(s.language, 'Sprache der Spracherkennung');
  const p = obj(b.phone);
  if (p.engine !== undefined) {
    if (!PHONE_ENGINES.includes(p.engine)) throw bad('Telefon: Twilio oder eigener Anbieter');
    out.phone.engine = p.engine;
  }
  if (p.transport !== undefined) {
    if (!PHONE_TRANSPORTS.includes(p.transport)) throw bad('Übertragung: automatisch, Live-Stream oder Aufnahme-Runden');
    out.phone.transport = p.transport;
  }
  if (p.tts_connection_id !== undefined) out.phone.tts_connection_id = id(p.tts_connection_id, 'Verbindung Telefon-Stimme');
  if (p.tts_model !== undefined) out.phone.tts_model = modelId(p.tts_model, 'Modell Telefon-Stimme');
  if (p.tts_voice !== undefined) out.phone.tts_voice = voiceId(p.tts_voice, 'Telefon-Stimme');
  if (p.stt_connection_id !== undefined) out.phone.stt_connection_id = id(p.stt_connection_id, 'Verbindung Telefon-Spracherkennung');
  if (p.stt_model !== undefined) out.phone.stt_model = modelId(p.stt_model, 'Modell Telefon-Spracherkennung');
  for (const k of ['tts_ws', 'barge_in', 'filler'] as const) if (p[k] !== undefined) out.phone[k] = bool(p[k]);
  if (p.endpoint_ms !== undefined) {
    const v = Math.round(num(p.endpoint_ms, NaN));
    if (!Number.isFinite(v) || v < 300 || v > 2500) throw bad('Pause bis zur Antwort: 300 bis 2500 ms');
    out.phone.endpoint_ms = v;
  }
  const a = obj(b.agent);
  for (const k of ['read_aloud', 'auto_send'] as const) if (a[k] !== undefined) out.agent[k] = bool(a[k]);
  if (b.voicemail_transcribe !== undefined) out.voicemail_transcribe = bool(b.voicemail_transcribe);
  if (b.call_summary !== undefined) out.call_summary = bool(b.call_summary);
  return out;
}

// --- per user (HyperLevel Agent panel) -------------------------------------------------------------------------------

export interface VoiceUserPrefs {
  /** null = the sub-account's default. */
  read_aloud: boolean | null;
  auto_send: boolean | null;
  voice: string;
  connection_id: string;
}

export const defaultUserPrefs = (): VoiceUserPrefs => ({ read_aloud: null, auto_send: null, voice: '', connection_id: '' });

export function withUserDefaults(stored: unknown): VoiceUserPrefs {
  const d = defaultUserPrefs();
  const o = obj(stored);
  return {
    read_aloud: typeof o.read_aloud === 'boolean' ? o.read_aloud : null,
    auto_send: typeof o.auto_send === 'boolean' ? o.auto_send : null,
    voice: typeof o.voice === 'string' ? o.voice : d.voice,
    connection_id: typeof o.connection_id === 'string' ? o.connection_id : d.connection_id,
  };
}

export function cleanUserPrefs(b: any, cur: VoiceUserPrefs): VoiceUserPrefs {
  const out = { ...cur };
  for (const k of ['read_aloud', 'auto_send'] as const) {
    if (b[k] === undefined) continue;
    out[k] = b[k] === null ? null : bool(b[k]);
  }
  if (b.voice !== undefined) out.voice = voiceId(b.voice, 'Stimme');
  if (b.connection_id !== undefined) out.connection_id = id(b.connection_id, 'Verbindung');
  return out;
}
