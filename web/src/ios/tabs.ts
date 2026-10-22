import type { IconName } from '../icons';

/** Which areas the bottom bar shows (pure, tests/ios-logic.test.ts). */

/** In this order: the first four the person may use and has not hidden. */
const FAVOURITES = ['dashboard', 'conversations', 'contacts', 'tasks', 'calendars', 'opportunities'];

/** Shorter than the menu's names – five labels share a phone's width. German message ids (TabBar translates them). */
const SHORT: Record<string, string> = { dashboard: 'Start', conversations: 'Nachrichten', contacts: 'Kontakte', tasks: 'Aufgaben', calendars: 'Kalender', opportunities: 'Deals' };

export interface TabEntry {
  route: string;
  icon: IconName;
  label: string;
}

/** Picks up to four tabs from the menu the person can see. */
export function pickTabs(entries: (readonly unknown[])[], visible: (route: string) => boolean, cur: string): TabEntry[] {
  const items = entries.filter((n) => n[0] !== 'group') as [string, IconName, string][];
  const usable = (r: string) => items.find((n) => n[0] === r && (visible(r) || r === cur));
  const chosen = FAVOURITES.map(usable).filter(Boolean).slice(0, 4) as [string, IconName, string][];
  // Nobody should end up without tabs (a login with a single area): fall back to the first entries of the menu.
  for (const n of items) {
    if (chosen.length >= 4) break;
    if (!chosen.includes(n) && visible(n[0]) && !['settings', 'academy', 'trash', 'agents', 'apps', 'umzug'].includes(n[0])) chosen.push(n);
  }
  return chosen.map(([route, icon, label]) => ({ route, icon, label: SHORT[route] ?? label }));
}

