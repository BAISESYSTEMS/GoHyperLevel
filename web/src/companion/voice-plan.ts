/**
 * Who speaks the companion's answers – pure (no browser, no fetch), shared by companion/voice.ts, focus/speech.ts and the tests.
 * Default ("auto"): Google Cloud Text-to-Speech with a native male voice in the app's language – "de-DE-Chirp3-HD-Iapetus" in German,
 * "en-US-Chirp3-HD-Iapetus" in English – through the sub-account's own "Google Cloud Speech" connection. Without a matching connection
 * the browser speaks – a natural male voice in that language when the default voice is chosen and no browser voice is picked.
 * "account" = the sub-account's own voice as before 1.0.53 (Einstellungen → Stimme), "browser" = always the browser's.
 * With kie.ai as provider "auto" is the ElevenLabs voice "Brian", told the app's language (no accent in either).
 */

export const DEFAULT_TTS_PROVIDER = 'google_speech';
export const DEFAULT_TTS_VOICE = 'auto';
export const JARVIS_VOICES = { de: 'de-DE-Chirp3-HD-Iapetus', en: 'en-US-Chirp3-HD-Iapetus' } as const;
export type Lang = 'de' | 'en';
/** Jarvis per speaking provider – the same table as server/services/companion-prefs.ts (tests/kie-jarvis-voice.test.ts keeps them equal). */
export const JARVIS_PROVIDER_VOICES: Record<string, { de: string; en: string }> = {
  google_speech: JARVIS_VOICES,
  kie: { de: 'nPczCjzI2devNBz1zQrb', en: 'nPczCjzI2devNBz1zQrb' },
};
/** Shown for "auto" in the settings, per provider. */
export const JARVIS_VOICE_LABELS: Record<string, { de: string; en: string }> = { google_speech: JARVIS_VOICES, kie: { de: 'Brian (ElevenLabs)', en: 'Brian (ElevenLabs)' } };
/**
 * 'auto' and the 1.0.53 default (a British voice that read German with an accent) → the Jarvis voice of the provider in the language
 * ('' for providers without one: their own default voice).
 */
export const resolveVoice = (voice: string, lang: Lang, provider: string = DEFAULT_TTS_PROVIDER): string => {
  if (voice !== 'auto' && voice !== 'en-GB-Neural2-B') return voice;
  const v = JARVIS_PROVIDER_VOICES[provider];
  return v ? v[lang === 'en' ? 'en' : 'de'] : '';
};
export const BROWSER_TTS = 'browser';
export const ACCOUNT_TTS = 'account';

export interface VoiceConn {
  id: string;
  label: string;
  provider: string;
  usable?: boolean;
}
export interface VoiceInfo {
  stt: boolean;
  /** the sub-account (or the person's agent voice) can speak via the server */
  tts: boolean;
  /** the sub-account's connections that can speak */
  connections: VoiceConn[];
}
export interface VoicePrefs {
  tts_provider: string;
  tts_connection_id: string;
  tts_voice: string;
  browser_voice: string;
}
export interface SpeechPlan {
  /** the companion's server voice: a connection of the sub-account and a voice */
  tts: { connection_id: string; voice?: string; lang: Lang } | null;
  /** the sub-account's own server voice ("account") */
  server: boolean;
  /** a browser voice by name */
  voice?: string;
  /** browser fallback: prefer a natural male voice in the app's language (the default voice is chosen, no browser voice picked) */
  preferNative: boolean;
}

/** The chosen connection of the companion's provider (the picked one, else the provider's first usable one). */
export function companionConnection(p: Pick<VoicePrefs, 'tts_provider' | 'tts_connection_id'>, conns: VoiceConn[]): VoiceConn | null {
  if (!p.tts_provider || p.tts_provider === BROWSER_TTS || p.tts_provider === ACCOUNT_TTS) return null;
  const usable = conns.filter((c) => c.usable !== false);
  return (p.tts_connection_id && usable.find((c) => c.id === p.tts_connection_id && c.provider === p.tts_provider)) || usable.find((c) => c.provider === p.tts_provider) || null;
}

export function speechPlan(p: VoicePrefs, info: VoiceInfo, lang: Lang = 'de'): SpeechPlan {
  const provider = p.tts_provider || DEFAULT_TTS_PROVIDER;
  const conn = companionConnection(p, info.connections);
  const chosen = p.tts_voice || '';
  const isDefault = !chosen || chosen === DEFAULT_TTS_VOICE || resolveVoice(chosen, lang) !== chosen;
  return {
    tts: conn ? { connection_id: conn.id, voice: (chosen && resolveVoice(chosen, lang, conn.provider)) || undefined, lang } : null,
    server: provider === ACCOUNT_TTS && info.tts,
    voice: p.browser_voice || undefined,
    preferNative: provider !== BROWSER_TTS && provider !== ACCOUNT_TTS && !p.browser_voice && isDefault,
  };
}

/**
 * Male voices by name in each language: Microsoft's natural online voices (Edge), Apple's and Google's. Natural/neural voices
 * first – they sound like a person; the robotic ones only when there is nothing else.
 */
const MALE = {
  de: /\b(Conrad|Killian|Florian|Ralf|Bernd|Christoph|Kasper|Klaus|Markus|Yannick|Viktor|Martin|Jonas|Stefan|Hans)\b/i,
  en: /\b(Andrew|Brian|Guy|Christopher|Eric|Roger|Steffan|Davis|Tony|Jason|Aaron|Evan|Nathan|Tom|Alex|Fred)\b|US English Male/i,
};
const NATURAL = /Natural|Neural|Online|Premium|Enhanced/i;
/** The browser's voice for Jarvis: a natural male voice of the language, else any natural one, else any voice of the language. */
export function pickNativeVoice<V extends { name: string; lang: string }>(voices: V[], lang: Lang): V | null {
  const region = lang === 'en' ? /^en[-_]US/i : /^de[-_]DE/i;
  const ofLang = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
  const rank = (v: V) => (region.test(v.lang) ? 0 : 4) + (MALE[lang].test(v.name) ? 0 : 2) + (NATURAL.test(v.name) ? 0 : 1);
  return ofLang.slice().sort((a, b) => rank(a) - rank(b))[0] ?? null;
}
