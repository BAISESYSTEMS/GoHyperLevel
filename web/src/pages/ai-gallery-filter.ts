/**
 * The provider gallery's search and filters (Einstellungen → KI-Anbieter): pure, so tests can run it without a browser.
 * `presets` are the entries of GET /api/ai-connections/presets.
 */

/** Providers that can also be used with a subscription (ChatGPT via sign-in or Codex, Claude via Claude Code). */
export const SUB_PRESETS = new Set(['openai', 'anthropic']);
/** Shown first, with a "Empfohlen" badge. */
export const PINNED = ['openrouter'];

export const FILTERS: [string, string][] = [
  ['eu', 'EU-Hosting'],
  ['cheap', 'günstig'],
  ['fast', 'schnell'],
  ['local', 'lokal'],
  ['sub', 'Abo-Anmeldung'],
];

export const tagsOf = (p: any): Set<string> => new Set([...(p.tags ?? []), ...(p.eu ? ['eu'] : []), ...(p.local || p.group === 'local' ? ['local'] : []), ...(SUB_PRESETS.has(p.id) ? ['sub'] : [])]);

/** What the gallery shows for a search text, a kind of provider and the active filters (all filters have to match). */
export function filterPresets(presets: any[], o: { q: string; kind: string; tags: string[] }) {
  const q = o.q.trim().toLowerCase();
  return presets
    .filter((p) => (!o.kind || p.group === o.kind) && o.tags.every((t) => tagsOf(p).has(t)) && (!q || `${p.label} ${p.id} ${p.capabilities.join(' ')} ${p.eu?.region ?? ''}`.toLowerCase().includes(q)))
    .sort((a, b) => Number(PINNED.includes(b.id)) - Number(PINNED.includes(a.id)));
}
