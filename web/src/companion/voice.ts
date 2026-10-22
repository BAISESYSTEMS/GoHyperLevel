import { api, currentLocation } from '../api';
import type { CompanionPrefs } from './store';
import { speechPlan, type SpeechPlan, type VoiceInfo } from './voice-plan';

export * from './voice-plan';

/**
 * The companion's voice (docs/living-boards.md#die-stimme-des-companions): which connections of the sub-account can speak is asked
 * once per sub-account and tab (GET /api/voice/prefs – open to everyone, no settings right needed) and cached; voice-plan.ts decides
 * who speaks (by default Google "de-DE-Chirp3-HD-Iapetus" / "en-US-Chirp3-HD-Iapetus" by language via POST /api/voice/speak with connection/voice, else the browser).
 */

const NONE: VoiceInfo = { stt: false, tts: false, connections: [] };
const TTL = 10 * 60_000;
let cache: { loc: string; at: number; p: Promise<VoiceInfo> } | null = null;

/** /api/voice/prefs once per sub-account (again after 10 minutes or with `force`); never throws. */
export function loadVoiceInfo(force = false): Promise<VoiceInfo> {
  const loc = currentLocation();
  if (!force && cache && cache.loc === loc && Date.now() - cache.at < TTL) return cache.p;
  const p = api
    .get<any>('/api/voice/prefs')
    .then(
      (v): VoiceInfo => ({
        stt: !!v?.ready?.stt,
        tts: !!v?.ready?.tts,
        connections: Array.isArray(v?.connections) ? v.connections.filter((c: any) => c && typeof c.id === 'string').map((c: any) => ({ id: c.id, label: String(c.label ?? ''), provider: String(c.provider ?? ''), usable: c.usable !== false })) : [],
      }),
    )
    .catch(() => NONE);
  cache = { loc, at: Date.now(), p };
  return p;
}

/** The companion's plan for the current sub-account (cached connections). */
export async function companionSpeech(p: CompanionPrefs, lang: 'de' | 'en' = 'de'): Promise<SpeechPlan> {
  return speechPlan(p, await loadVoiceInfo(), lang);
}
