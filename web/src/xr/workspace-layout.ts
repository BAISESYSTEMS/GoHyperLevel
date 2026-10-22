import { XR_LIMITS, defaultWorkspace, evenSizes, isWorkspaceRoute, normalizeSizes, type WorkspaceLayout } from '../../../server/services/xr-model';

/**
 * The Arbeitsfläche as plain functions: which pages sit side by side, how wide each one is, where a link opens, what is saved.
 * No React and no DOM, so every rule is tested (tests/xr-workspace.test.ts); Workspace.tsx only draws the result.
 */

/** Narrowest a panel may be drawn (px); more panels than fit are not offered. */
export const MIN_PANEL_PX = 440;
/** Below this width of the work area the Arbeitsfläche falls back to one page at a time (normal navigation). */
export const COMPACT_BELOW_PX = 1000;
/** Keyboard step of a splitter, as a share of the width (Shift = the large step). */
export const SPLIT_STEP = 0.02;
export const SPLIT_STEP_LARGE = 0.08;

export interface PanelState {
  /** Stable while the panel exists (a React key), not saved. */
  id: string;
  route: string;
  /** Share of the width, all panels add up to 1. */
  size: number;
}
export interface WorkspaceState {
  panels: PanelState[];
  sync: boolean;
}

// --- routes -------------------------------------------------------------------------------------------------

/** "/app/contacts/abc?x=1#y" or "contacts/abc" → ["contacts", "abc"]. */
export function toParts(to: string): string[] {
  const path = to.split(/[?#]/)[0].replace(/^\/?app(?:\/|$)/, '').replace(/^\/+/, '');
  return path.split('/').filter(Boolean);
}
export const toRoute = (parts: string[]) => parts.join('/');

/** Pages offered in a panel's page chooser (any other page still opens by a link). */
export const PAGES: [route: string, label: string][] = [
  ['conversations', 'Posteingang'],
  ['contacts', 'Kontakte'],
  ['opportunities', 'Pipeline'],
  ['tasks', 'Aufgaben'],
  ['pm', 'Projektplanung'],
  ['calendars', 'Kalender'],
  ['boards', 'Boards'],
  ['canvas', 'Canvas'],
  ['dashboard', 'Dashboard'],
  ['agent', 'KI-Agent'],
  ['tickets', 'Tickets'],
  ['companies', 'Firmen'],
  ['invoices', 'Rechnungen'],
  ['campaigns', 'Kampagnen'],
  ['workflows', 'Automationen'],
  ['reports', 'Berichte'],
  ['wiki', 'Wiki'],
  ['team-chat', 'Team-Chat'],
];

export function routeLabel(route: string): string {
  const head = route.split('/')[0];
  const known = PAGES.find(([r]) => r === head)?.[1];
  if (known) return known;
  const words = head.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Pages whose second segment names a place to work in (a board, a canvas, a project) and is worth keeping; for all the others
 *  it is a selection (this contact, that conversation) that is not saved: the Arbeitsfläche opens at the list again. */
const KEEPS_ID = new Set(['boards', 'canvas', 'wiki', 'pm', 'reports', 'settings', 'team-chat']);
export function persistRoute(route: string): string {
  const parts = route.split('/');
  const out = KEEPS_ID.has(parts[0]) ? parts.slice(0, 2) : parts.slice(0, 1);
  const r = out.join('/');
  return isWorkspaceRoute(r) ? r : parts[0];
}

// --- state <-> saved layout ----------------------------------------------------------------------------------

let seq = 0;
export const newPanelId = () => `p${++seq}`;

export function fromLayout(l: WorkspaceLayout, id: () => string = newPanelId): WorkspaceState {
  const sizes = normalizeSizes(l.panels.map((p) => p.size));
  return { panels: l.panels.map((p, i) => ({ id: id(), route: p.route, size: sizes[i] })), sync: l.sync };
}
export function toLayout(s: WorkspaceState): WorkspaceLayout {
  return { v: 1, panels: s.panels.map((p) => ({ route: persistRoute(p.route), size: p.size })), sync: s.sync };
}
export const defaultState = (count: number, id: () => string = newPanelId): WorkspaceState => fromLayout(defaultWorkspace(count), id);

/** How many panels fit side by side in a work area of this width. */
export const maxPanelsFor = (width: number) => Math.max(1, Math.min(XR_LIMITS.workspacePanels, Math.floor(width / MIN_PANEL_PX)));
export const isCompact = (width: number) => width < COMPACT_BELOW_PX;

// --- widths -------------------------------------------------------------------------------------------------

/** Moves the boundary between panel i and i+1 by `delta` (a share of the width): one grows, the other shrinks, nobody below `min`. */
export function resizeBetween(sizes: number[], i: number, delta: number, min: number = XR_LIMITS.minShare): number[] {
  if (i < 0 || i >= sizes.length - 1) return sizes;
  const pair = sizes[i] + sizes[i + 1];
  const left = Math.min(pair - min, Math.max(min, sizes[i] + delta));
  const next = sizes.slice();
  next[i] = left;
  next[i + 1] = pair - left;
  return next.map((n) => Math.round(n * 10000) / 10000);
}

/** A keyboard press on a splitter: arrows move it (Shift = large step), Home / End push it as far as it goes. */
export function splitterKey(sizes: number[], i: number, key: string, shift = false, min: number = XR_LIMITS.minShare): number[] | null {
  const step = shift ? SPLIT_STEP_LARGE : SPLIT_STEP;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return resizeBetween(sizes, i, -step, min);
  if (key === 'ArrowRight' || key === 'ArrowDown') return resizeBetween(sizes, i, step, min);
  if (key === 'Home') return resizeBetween(sizes, i, -1, min);
  if (key === 'End') return resizeBetween(sizes, i, 1, min);
  return null;
}

// --- editing the set of panels --------------------------------------------------------------------------------

const withSizes = (panels: Omit<PanelState, 'size'>[] | PanelState[], sizes: number[]): PanelState[] => panels.map((p, i) => ({ id: p.id, route: p.route, size: sizes[i] }));

/** A new panel on the right (up to four): it takes its share from the others in proportion. */
export function addPanel(s: WorkspaceState, route: string, id: () => string = newPanelId): WorkspaceState {
  if (s.panels.length >= XR_LIMITS.workspacePanels) return s;
  const share = 1 / (s.panels.length + 1);
  const rest = s.panels.map((p) => p.size * (1 - share));
  const panels = [...withSizes(s.panels, rest), { id: id(), route, size: share }];
  return { ...s, panels: withSizes(panels, normalizeSizes(panels.map((p) => p.size))) };
}

export function removePanel(s: WorkspaceState, index: number): WorkspaceState {
  if (s.panels.length <= 1 || index < 0 || index >= s.panels.length) return s;
  const panels = s.panels.filter((_, i) => i !== index);
  return { ...s, panels: withSizes(panels, normalizeSizes(panels.map((p) => p.size))) };
}

/** Swaps a panel with its neighbour (the alternative to dragging a panel by its handle). */
export function movePanel(s: WorkspaceState, index: number, dir: -1 | 1): WorkspaceState {
  const j = index + dir;
  if (index < 0 || j < 0 || j >= s.panels.length) return s;
  const panels = s.panels.slice();
  [panels[index], panels[j]] = [panels[j], panels[index]];
  return { ...s, panels };
}

export function setPanelRoute(s: WorkspaceState, index: number, route: string): WorkspaceState {
  if (index < 0 || index >= s.panels.length || s.panels[index].route === route) return s;
  return { ...s, panels: s.panels.map((p, i) => (i === index ? { ...p, route } : p)) };
}

/** Exactly `count` panels: the first ones keep their pages, new ones come from the default order; widths even out. */
export function applyCount(s: WorkspaceState, count: number, id: () => string = newPanelId): WorkspaceState {
  const n = Math.max(1, Math.min(XR_LIMITS.workspacePanels, Math.round(count)));
  const defaults = defaultWorkspace().panels.map((p) => p.route);
  const panels: PanelState[] = s.panels.slice(0, n);
  for (const route of defaults) {
    if (panels.length >= n) break;
    if (!panels.some((p) => p.route.split('/')[0] === route)) panels.push({ id: id(), route, size: 0 });
  }
  while (panels.length < n) panels.push({ id: id(), route: 'dashboard', size: 0 });
  return { ...s, panels: withSizes(panels, evenSizes(n)) };
}

// --- where a link opens --------------------------------------------------------------------------------------

/**
 * A page was opened from inside panel `from` (a click on a link, navigate()). It opens in the panel that already shows
 * that kind of page – a contact link in the inbox updates the contact panel instead of replacing the inbox – else in the
 * panel it came from. Returns the index of the panel that takes it.
 */
export function targetPanel(routes: string[], from: number, to: string[]): number {
  const kind = to[0];
  if (!kind) return from;
  if (routes[from]?.split('/')[0] === kind) return from;
  const j = routes.findIndex((r) => r.split('/')[0] === kind);
  return j >= 0 ? j : from;
}

/** The panel that shows contacts (a selection elsewhere updates it), or -1. */
export const contactPanel = (routes: string[]) => routes.findIndex((r) => r.split('/')[0] === 'contacts');

/** What the contact panel shows after someone picked this contact elsewhere; null = leave things as they are. */
export function selectContact(s: WorkspaceState, contactId: string | undefined): WorkspaceState | null {
  if (!s.sync || !contactId || !/^[A-Za-z0-9_-]{1,64}$/.test(contactId)) return null;
  const j = contactPanel(s.panels.map((p) => p.route));
  if (j < 0) return null;
  const route = `contacts/${contactId}`;
  return s.panels[j].route === route ? null : setPanelRoute(s, j, route);
}
