/**
 * The product names of the plugin feature live here and nowhere else: rename "Werkstatt" (where wishes get
 * built) or "Marktplatz" (where plugins are discovered and installed) in this one file and both the server
 * messages and the web app follow. Pure data – the web app imports this file too.
 */
export const NAMES = {
  werkstatt: 'Werkstatt',
  marktplatz: 'Marktplatz',
  plugin: 'Plugin',
  plugins: 'Plugins',
  build: 'Bauen lassen',
  change: 'Ändern lassen',
  stage1: 'Einrichtung',
  stage2: 'Mini-App',
  stage3: 'Kernfeature',
  inCore: 'im Kern enthalten',
} as const;

/** Agent tools whose results the chat shows as cards (web/src/werkstatt/ChatCards.tsx); the others only get their normal tool card. */
export const CARD_TOOLS = ['ghl_build_from_wish', 'ghl_change_plugin', 'ghl_plugin_status'] as const;

/** App routes (/app/<route>) of the two pages. */
export const ROUTES = { werkstatt: 'werkstatt', marktplatz: 'marktplatz', plugin: 'plugin' } as const;

/** Where a plugin is active: only for its author → the sub-account → the whole agency → listed in the Marktplatz. */
export const PLUGIN_SCOPES = ['private', 'location', 'agency', 'marketplace'] as const;
export type PluginScope = (typeof PLUGIN_SCOPES)[number];
export const SCOPE_LABELS: Record<PluginScope, string> = {
  private: 'Privat (nur du)',
  location: 'Sub-Account',
  agency: 'Agentur-weit',
  marketplace: NAMES.marktplatz,
};

export const STAGE_LABELS: Record<number, string> = { 1: NAMES.stage1, 2: NAMES.stage2 };
