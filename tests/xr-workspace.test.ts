import { describe, expect, it, vi } from 'vitest';
import { XR_LIMITS, cleanWorkspace } from '../server/services/xr-model';
import {
  COMPACT_BELOW_PX,
  MIN_PANEL_PX,
  addPanel,
  applyCount,
  contactPanel,
  defaultState,
  fromLayout,
  isCompact,
  maxPanelsFor,
  movePanel,
  persistRoute,
  removePanel,
  resizeBetween,
  routeLabel,
  selectContact,
  setPanelRoute,
  splitterKey,
  targetPanel,
  toLayout,
  toParts,
  toRoute,
  type WorkspaceState,
} from '../web/src/xr/workspace-layout';
import { publishSelection, subscribeSelection } from '../web/src/xr/selection';

let n = 0;
const id = () => `t${++n}`;
const state = (routes: string[], sizes?: number[]): WorkspaceState => ({ sync: true, panels: routes.map((route, i) => ({ id: id(), route, size: sizes?.[i] ?? 1 / routes.length })) });
const sum = (s: WorkspaceState) => s.panels.reduce((a, p) => a + p.size, 0);

describe('Arbeitsfläche: routes', () => {
  it('turns a link into route parts', () => {
    expect(toParts('/app/contacts/abc?x=1#y')).toEqual(['contacts', 'abc']);
    expect(toParts('contacts/abc')).toEqual(['contacts', 'abc']);
    expect(toParts('/app')).toEqual([]);
    expect(toParts('/app/')).toEqual([]);
    expect(toParts('/appointments/x')).toEqual(['appointments', 'x']);
    expect(toRoute(['boards', 'b1'])).toBe('boards/b1');
  });

  it('names panels in German, with a fallback', () => {
    expect(routeLabel('conversations')).toBe('Posteingang');
    expect(routeLabel('contacts/abc')).toBe('Kontakte');
    expect(routeLabel('agent')).toBe('KI-Agent');
    expect(routeLabel('help-center')).toBe('Help center');
  });

  it('saves a place to work in (a board, a canvas) but not a selection (this contact, that conversation)', () => {
    expect(persistRoute('boards/b1')).toBe('boards/b1');
    expect(persistRoute('canvas/c9/extra')).toBe('canvas/c9');
    expect(persistRoute('contacts/abc')).toBe('contacts');
    expect(persistRoute('conversations/xyz')).toBe('conversations');
    expect(persistRoute('opportunities')).toBe('opportunities');
    expect(persistRoute('agent')).toBe('agent');
  });
});

describe('Arbeitsfläche: the saved layout', () => {
  it('round-trips through the server model and comes back valid', () => {
    const s = fromLayout(cleanWorkspace({ panels: [{ route: 'conversations', size: 2 }, { route: 'contacts/abc', size: 1 }, { route: 'boards/b1', size: 1 }], sync: false }), id);
    expect(s.sync).toBe(false);
    expect(sum(s)).toBeCloseTo(1, 3);
    const out = toLayout(s);
    expect(out.panels.map((p) => p.route)).toEqual(['conversations', 'contacts', 'boards/b1']);
    expect(cleanWorkspace(out)).toEqual(out);
    // a selection in the contact panel is not saved
    expect(toLayout(setPanelRoute(s, 1, 'contacts/zzz')).panels[1].route).toBe('contacts');
  });

  it('starts with Inbox | Kontakt | Board | Agent', () => {
    expect(defaultState(4, id).panels.map((p) => p.route)).toEqual(['conversations', 'contacts', 'boards', 'agent']);
    expect(defaultState(2, id).panels.map((p) => p.route)).toEqual(['conversations', 'contacts']);
    expect(sum(defaultState(3, id))).toBeCloseTo(1, 3);
  });

  it('fits as many panels as the width allows and falls back to single pages below the breakpoint', () => {
    expect(maxPanelsFor(3840)).toBe(XR_LIMITS.workspacePanels);
    expect(maxPanelsFor(1920)).toBe(4);
    expect(maxPanelsFor(1300)).toBe(2);
    expect(maxPanelsFor(MIN_PANEL_PX * 3)).toBe(3);
    expect(maxPanelsFor(300)).toBe(1);
    expect(maxPanelsFor(0)).toBe(1);
    expect(isCompact(COMPACT_BELOW_PX - 1)).toBe(true);
    expect(isCompact(COMPACT_BELOW_PX)).toBe(false);
    expect(isCompact(390)).toBe(true);
  });
});

describe('Arbeitsfläche: splitters', () => {
  it('moves the boundary between two panels and nobody falls below the minimum', () => {
    const r = resizeBetween([0.5, 0.3, 0.2], 0, 0.1);
    expect(r[0]).toBeCloseTo(0.6, 4);
    expect(r[1]).toBeCloseTo(0.2, 4);
    expect(r[2]).toBe(0.2);
    const far = resizeBetween([0.5, 0.3, 0.2], 1, 5);
    expect(far[1]).toBeCloseTo(0.5 - XR_LIMITS.minShare, 3);
    expect(far[2]).toBeCloseTo(XR_LIMITS.minShare, 3);
    expect(resizeBetween([0.5, 0.5], 0, -5)[0]).toBeCloseTo(XR_LIMITS.minShare, 4);
    expect(resizeBetween([0.5, 0.5], 1, 0.1)).toEqual([0.5, 0.5]);
    expect(resizeBetween([0.5, 0.5], -1, 0.1)).toEqual([0.5, 0.5]);
    // the sum never changes
    for (const d of [-0.4, -0.05, 0.02, 0.3]) expect(resizeBetween([0.4, 0.35, 0.25], 0, d).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
  });

  it('works from the keyboard: arrows (Shift = large step), Home and End', () => {
    const a = [0.5, 0.5];
    expect(splitterKey(a, 0, 'ArrowRight')![0]).toBeCloseTo(0.52, 4);
    expect(splitterKey(a, 0, 'ArrowLeft')![0]).toBeCloseTo(0.48, 4);
    expect(splitterKey(a, 0, 'ArrowRight', true)![0]).toBeCloseTo(0.58, 4);
    expect(splitterKey(a, 0, 'End')![0]).toBeCloseTo(1 - XR_LIMITS.minShare, 4);
    expect(splitterKey(a, 0, 'Home')![0]).toBeCloseTo(XR_LIMITS.minShare, 4);
    expect(splitterKey(a, 0, 'Tab')).toBeNull();
    expect(splitterKey(a, 0, 'a')).toBeNull();
  });
});

describe('Arbeitsfläche: panels', () => {
  it('adds up to four, removes down to one, and keeps the widths adding up to 1', () => {
    let s = state(['conversations', 'contacts']);
    s = addPanel(s, 'boards', id);
    expect(s.panels.map((p) => p.route)).toEqual(['conversations', 'contacts', 'boards']);
    expect(sum(s)).toBeCloseTo(1, 3);
    expect(s.panels[2].size).toBeCloseTo(1 / 3, 2);
    s = addPanel(s, 'agent', id);
    expect(addPanel(s, 'tasks', id)).toBe(s);
    s = removePanel(s, 0);
    expect(s.panels).toHaveLength(3);
    expect(sum(s)).toBeCloseTo(1, 3);
    let one = state(['tasks']);
    expect(removePanel(one, 0)).toBe(one);
    one = removePanel(state(['a', 'b']), 1);
    expect(one.panels).toHaveLength(1);
    expect(one.panels[0].size).toBe(1);
    expect(removePanel(s, 9)).toBe(s);
  });

  it('moves a panel past its neighbour (the alternative to dragging it) and changes its page', () => {
    const s = state(['a', 'b', 'c']);
    expect(movePanel(s, 0, 1).panels.map((p) => p.route)).toEqual(['b', 'a', 'c']);
    expect(movePanel(s, 2, -1).panels.map((p) => p.route)).toEqual(['a', 'c', 'b']);
    expect(movePanel(s, 0, -1)).toBe(s);
    expect(movePanel(s, 2, 1)).toBe(s);
    // ids stay with their panels, so a page keeps its state when it moves
    expect(movePanel(s, 0, 1).panels[1].id).toBe(s.panels[0].id);
    expect(setPanelRoute(s, 1, 'tasks').panels[1].route).toBe('tasks');
    expect(setPanelRoute(s, 1, 'b')).toBe(s);
    expect(setPanelRoute(s, 7, 'x')).toBe(s);
  });

  it('switches to 2, 3 or 4 panels keeping the pages the person already has', () => {
    const s = state(['tasks', 'contacts']);
    const three = applyCount(s, 3, id);
    expect(three.panels.map((p) => p.route.split('/')[0])).toEqual(['tasks', 'contacts', 'conversations']);
    expect(sum(three)).toBeCloseTo(1, 3);
    const four = applyCount(three, 4, id);
    expect(four.panels.map((p) => p.route)).toEqual(['tasks', 'contacts', 'conversations', 'boards']);
    expect(applyCount(four, 2, id).panels.map((p) => p.route)).toEqual(['tasks', 'contacts']);
    expect(applyCount(s, 99, id).panels).toHaveLength(4);
    expect(applyCount(s, 0, id).panels).toHaveLength(1);
    // widths even out
    expect(applyCount(state(['a', 'b', 'c'], [0.7, 0.2, 0.1]), 3, id).panels.map((p) => p.size)).toEqual([0.3333, 0.3333, 0.3333]);
  });
});

describe('Arbeitsfläche: where a link opens, and what a pick updates', () => {
  it('opens a page in the panel that already shows that kind of page, else in the panel it came from', () => {
    const routes = ['conversations', 'contacts', 'boards', 'agent'];
    expect(targetPanel(routes, 0, ['contacts', 'abc'])).toBe(1);
    expect(targetPanel(routes, 2, ['contacts', 'abc'])).toBe(1);
    expect(targetPanel(routes, 1, ['contacts', 'xyz'])).toBe(1);
    expect(targetPanel(routes, 0, ['tickets', 't1'])).toBe(0);
    expect(targetPanel(routes, 3, ['boards', 'b1'])).toBe(2);
    expect(targetPanel(routes, 0, [])).toBe(0);
    expect(targetPanel(['contacts', 'contacts/a'], 1, ['contacts', 'b'])).toBe(1);
  });

  it('updates the contact panel when something else picks a contact, only with the link on and only for real ids', () => {
    const s = state(['conversations', 'contacts', 'boards']);
    const next = selectContact(s, 'abc123')!;
    expect(next.panels[1].route).toBe('contacts/abc123');
    expect(next.panels[0].route).toBe('conversations');
    expect(selectContact(next, 'abc123')).toBeNull();
    expect(selectContact({ ...s, sync: false }, 'abc123')).toBeNull();
    expect(selectContact(state(['conversations', 'boards']), 'abc123')).toBeNull();
    expect(selectContact(s, undefined)).toBeNull();
    for (const bad of ['../x', 'a/b', '', 'x'.repeat(65), 'a b']) expect(selectContact(s, bad), bad).toBeNull();
    expect(contactPanel(['boards', 'contacts/x'])).toBe(1);
    expect(contactPanel(['boards'])).toBe(-1);
  });

  it('a pick published by a page reaches whoever listens, and stops reaching them after they leave', () => {
    const seen: (string | undefined)[] = [];
    const off = subscribeSelection((sel) => seen.push(sel.contactId));
    publishSelection({ contactId: 'a' });
    off();
    publishSelection({ contactId: 'b' });
    expect(seen).toEqual(['a']);
    // nobody listening: publishing is harmless
    expect(() => publishSelection({ contactId: 'c' })).not.toThrow();
    vi.restoreAllMocks();
  });
});

describe('the Raum-Modus suggestion', () => {
  it('asks only where WebXR is offered, the mode is on "automatisch", not yet on and not declined', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    const { shouldSuggest } = await import('../web/src/xr/SpatialSuggest');
    const base = { pref: 'auto' as const, active: false, supported: true, dismissed: false };
    expect(shouldSuggest(base)).toBe(true);
    expect(shouldSuggest({ ...base, supported: false })).toBe(false);
    expect(shouldSuggest({ ...base, active: true })).toBe(false);
    expect(shouldSuggest({ ...base, dismissed: true })).toBe(false);
    expect(shouldSuggest({ ...base, pref: 'on' })).toBe(false);
    expect(shouldSuggest({ ...base, pref: 'off' })).toBe(false);
    vi.unstubAllGlobals();
  });
});
