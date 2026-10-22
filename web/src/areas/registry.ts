import type { IconName } from '../icons';
import { AREA_DESC, AREA_KEYWORDS, QUICK_ACTIONS, type QuickAction } from './info';

/**
 * The area registry of the web shell: one entry per menu area with its icon, label, permission, menu section, a one-line
 * description, search words and quick actions. main.tsx registers its NAV once (`registerNav(NAV)`); a feature module can
 * add or extend an area with `registerArea()` in its own file. The sidebar ("Mehr"), the phone tabs, the command palette,
 * the Start page and the settings hub read it. Labels and descriptions are German message ids (shell / simple catalogs).
 */

export interface AreaDef {
  route: string;
  icon: IconName;
  label: string;
  perm: string;
  /** The menu group heading ('' for the top group). */
  section: string;
  desc: string;
  keywords: string;
  quick: QuickAction[];
}

type NavRow = readonly [string, ...unknown[]];

const areas = new Map<string, AreaDef>();

/** The menu of main.tsx: [route, icon, label, permission] rows and ['group', heading] rows. */
export function registerNav(nav: readonly NavRow[]) {
  let section = '';
  for (const n of nav) {
    if (n[0] === 'group') {
      section = String(n[1] ?? '');
      continue;
    }
    const [route, icon, label, perm] = n as unknown as [string, IconName, string, string];
    registerArea({ route, icon, label, perm, section });
  }
}

/** Adds an area or extends one (a later call merges; quick actions are appended). */
export function registerArea(def: Partial<AreaDef> & { route: string }) {
  const cur = areas.get(def.route);
  const quick = [...(cur?.quick ?? QUICK_ACTIONS.filter((q) => q.area === def.route)), ...(def.quick ?? [])];
  areas.set(def.route, {
    icon: 'layers',
    label: def.route,
    perm: '*',
    section: '',
    desc: AREA_DESC[def.route] ?? '',
    keywords: AREA_KEYWORDS[def.route] ?? '',
    ...cur,
    ...def,
    quick,
  });
}

export const allAreas = (): AreaDef[] => [...areas.values()];
export const areaOf = (route: string): AreaDef | undefined => areas.get(route);
export const quickActions = (): QuickAction[] => allAreas().flatMap((a) => a.quick);
export type { QuickAction };
