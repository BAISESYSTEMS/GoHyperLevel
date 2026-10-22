import { useEffect, useState } from 'react';
import { api } from '../api';
import { ICONS, Icon, type IconName } from '../icons';
import { Badge } from '../ui';
import { CARD_TOOLS, NAMES, ROUTES, SCOPE_LABELS, type PluginScope } from '../../../server/services/werkstatt/names';

/** Shared bits of the Werkstatt and Marktplatz screens (names live in server/services/werkstatt/names.ts). */
export { NAMES, ROUTES, SCOPE_LABELS, CARD_TOOLS };

/** The icon a plugin asks for, or a puzzle piece. */
export const pluginIcon = (name?: string): IconName => (name && name in ICONS ? (name as IconName) : 'puzzle');
export function PluginIcon({ name, size = 18 }: { name?: string; size?: number }) {
  return <Icon name={pluginIcon(name)} size={size} />;
}

export const usd = (v: number) => `${v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
export const SCOPE_TONE: Record<PluginScope, 'gray' | 'blue' | 'purple' | 'green'> = { private: 'gray', location: 'blue', agency: 'purple', marketplace: 'green' };
export function ScopeBadge({ scope }: { scope: PluginScope }) {
  return <Badge tone={SCOPE_TONE[scope] ?? 'gray'}>{SCOPE_LABELS[scope] ?? scope}</Badge>;
}

export const STATUS_TONE: Record<string, 'gray' | 'green' | 'red' | 'blue' | 'yellow'> = { planning: 'blue', planned: 'yellow', awaiting_approval: 'yellow', building: 'blue', done: 'green', failed: 'red', cancelled: 'gray', rejected: 'red', undone: 'gray' };

// --- the active plugins of this sub-account (menu, panels, widgets) -----------------------------------------

export interface ActivePlugin {
  id: string;
  slug: string;
  name: string;
  icon: string;
  version: string;
  page: { title: string; icon?: string } | null;
  panels: { id: string; on: 'contact' | 'deal'; title: string; height?: number }[];
  widgets: { id: string; title: string; size?: 's' | 'm' | 'l' }[];
}
let cache: { loc: string; list: ActivePlugin[] } | undefined;
const subs = new Set<(l: ActivePlugin[]) => void>();
/** Reloads the list (after installing, switching off …). */
export async function refreshPlugins(): Promise<ActivePlugin[]> {
  let list: ActivePlugin[] = [];
  try {
    list = await api.get<ActivePlugin[]>('/api/plugins/active');
  } catch {
    /* signed out */
  }
  cache = { loc: localStorage.getItem('pghl.location') ?? '', list };
  subs.forEach((f) => f(list));
  return list;
}
export function useActivePlugins(): ActivePlugin[] {
  const loc = localStorage.getItem('pghl.location') ?? '';
  const [list, setList] = useState<ActivePlugin[]>(cache && cache.loc === loc ? cache.list : []);
  useEffect(() => {
    subs.add(setList);
    if (!cache || cache.loc !== loc) void refreshPlugins();
    return () => void subs.delete(setList);
  }, [loc]);
  return list;
}

/** Opens the „Bauen lassen“ dialog from anywhere (wish page, new-wish dialog, Werkstatt). */
export type BuildRequest = { wishId?: string; title?: string; text?: string };
/** A request made before the dialog's code has loaded (the layer is a deferred chunk): it picks it up when it mounts. */
export const pendingBuild: { v?: BuildRequest } = {};
export const openBuild = (o: BuildRequest = {}) => {
  pendingBuild.v = o;
  window.dispatchEvent(new CustomEvent('pghl:build', { detail: o }));
};
