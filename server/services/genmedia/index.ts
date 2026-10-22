import { customHttpAdapter } from './custom-http.js';
import { elevenlabsAdapter } from './elevenlabs.js';
import { falAdapter } from './fal.js';
import { geminiAdapter } from './gemini.js';
import { kieAdapter } from './kie.js';
import { lumaAdapter } from './luma.js';
import { openaiAdapter } from './openai.js';
import { replicateAdapter } from './replicate.js';
import { runwayAdapter } from './runway.js';
import { stabilityAdapter } from './stability.js';
import type { Adapter, Capability } from './types.js';

/**
 * One adapter per provider preset id of the BYOK registry. A provider id we don't know falls back
 * to the custom HTTP template, so new presets keep working as long as a template is set.
 */
export const ADAPTERS: Record<string, Adapter> = Object.fromEntries(
  [falAdapter, kieAdapter, replicateAdapter, openaiAdapter, geminiAdapter, stabilityAdapter, elevenlabsAdapter, runwayAdapter, lumaAdapter, customHttpAdapter].map((a) => [a.id, a]),
);

/** Other spellings a registry might use for the same provider. */
const ALIASES: Record<string, string> = { 'fal.ai': 'fal', falai: 'fal', 'kie.ai': 'kie', kieai: 'kie', google: 'gemini', 'google-gemini': 'gemini', stabilityai: 'stability', 'stability-ai': 'stability', eleven: 'elevenlabs', 'eleven-labs': 'elevenlabs', runwayml: 'runway', lumalabs: 'luma', 'luma-ai': 'luma', custom: 'custom_http', http: 'custom_http', 'custom-http': 'custom_http' };

/** Adapters added by other modules (the voice layer brings Deepgram, Cartesia, Azure Speech …); `aliases` are more preset ids for it. */
export function registerAdapter(a: Adapter, aliases: string[] = []) {
  ADAPTERS[a.id] = a;
  for (const x of aliases) ALIASES[x] = a.id;
}

export function adapterFor(provider: string): Adapter {
  const id = String(provider ?? '').toLowerCase().trim();
  return ADAPTERS[id] ?? ADAPTERS[ALIASES[id] ?? ''] ?? customHttpAdapter;
}

export const supports = (a: Adapter, cap: Capability) => a.id === 'custom_http' || a.capabilities.includes(cap);

/** Provider catalogue for the UI (labels, capabilities, model suggestions). */
export function catalogue() {
  return Object.values(ADAPTERS).map((a) => ({ id: a.id, label: a.label, capabilities: a.capabilities, models: a.models, voices: !!a.voices }));
}
