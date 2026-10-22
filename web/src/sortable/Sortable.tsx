import { Children, Fragment, cloneElement, isValidElement, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { applyOrder, safeKey, sameOrder, tileKey } from '../../../server/services/tile-order';
import { tr, useT } from '../i18n';
import { SessionCtx } from '../session';
import { useLook } from '../theme/store';
import { SortController, announceText } from './drag';
import { adoptLook, bindUser, resetOrder, saveOrder, useSavedOrder } from './store';
import './sortable.css';

/**
 * Tiles and cards in your own order, everywhere (docs/theming.md#kacheln-sortieren): drag any tile by its surface – no
 * handles – or move the focused one with Alt+Shift+arrow keys. The order is saved per person and grid (server + this
 * browser, web/src/sortable/store.ts); tiles that are new appear at the end, tiles that are gone drop out.
 *
 *   <SortableGrid id="invoices.stats" className="stats">…the tiles…</SortableGrid>
 *
 * SortableGrid reorders its direct children by their React keys (children without a key are told apart by their position
 * in the code: "#0", "#1" …). For tiles that are not direct children (rows packed from one list), use the hook:
 *
 *   const s = useSortable({ id: 'focus.tiles', keys });   // s.order = the keys in the person's order
 *   <div ref={s.ref} data-sortable="">…render s.order, each tile with data-sort-key={key}…</div>
 */

export interface SortableOptions {
  /** The grid's id – stable, unique per arrangement, [a-z0-9._:-]: "dashboard.stats". */
  id: string;
  /** The keys of the sortable tiles shown right now, in their natural order. */
  keys: string[];
  disabled?: boolean;
  /** SortableGrid with keepDom: the saved order is shown with CSS `order` on the children, which stay in their natural DOM order. */
  keepDom?: boolean;
}

export interface Sortable {
  /** The keys in the order to render (during a drag: the live preview). */
  order: string[];
  /** Goes on the grid element (together with data-sortable). */
  ref: (el: HTMLElement | null) => void;
  /** The person arranged this grid differently from the natural order. */
  changed: boolean;
  reset: () => void;
  /** SortableGrid only: the key of each direct child in DOM order (null = not sortable), for children that do not render data-sort-key. */
  domKeys: { current: (string | null)[] | null };
}

/**
 * Binds the order store to the signed-in person and hands it the server's copy once the appearance answer is in. Every grid
 * that mounts hands over the look store's copy; the store takes each copy only once (adoptLook), so a grid mounting after
 * a save – another page, the next Fokus answer – never brings back the order from sign-in.
 */
function useServerCopy() {
  const session = useContext(SessionCtx);
  const look = useLook();
  const uid = session?.user?.id ?? '';
  // during render, so the first paint already shows this person's order from the browser's storage (other subscribers
  // hear about it a microtask later, never in the middle of this render)
  bindUser(uid);
  useEffect(() => {
    if (look.loaded) adoptLook(look.prefs.tile_order);
  }, [look.loaded, look.prefs.tile_order]);
}

export function useSortable({ id, keys, disabled, keepDom }: SortableOptions): Sortable {
  useServerCopy();
  const t = useT('core');
  const saved = useSavedOrder(id);
  const sig = keys.join('\u0001');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const natural = useMemo(() => keys, [sig]);
  const applied = useMemo(() => applyOrder(saved, natural), [saved, natural]);
  const [preview, setPreview] = useState<string[] | null>(null);
  const order = useMemo(() => (preview ? applyOrder(preview, natural) : applied), [preview, applied, natural]);
  const domKeys = useRef<(string | null)[] | null>(null);
  const live = useRef({ id, order, natural, disabled: !!disabled, keepDom: !!keepDom });
  live.current = { id, order, natural, disabled: !!disabled || natural.length < 2, keepDom: !!keepDom };
  const ctl = useRef<SortController | null>(null);
  const box = useRef<HTMLElement | null>(null);
  // While dragging, a grid of direct children (CSS grid or flex) previews the order with CSS `order` – nothing moves in the
  // DOM, so iframes in a tile do not reload and the pressed element stays where the browser expects it. Only the drop
  // renders the new order.
  const cssPreview = useRef<string[] | null>(null);
  const clearCss = () => {
    if (!cssPreview.current) return false;
    cssPreview.current = null;
    const c = box.current;
    // keepDom: the saved order lives in CSS `order` (React renders it) – back to it, not to the DOM order
    if (c && live.current.keepDom && domKeys.current) cssOrder(c, live.current.order, domKeys.current);
    else for (const el of Array.from(c?.children ?? []) as HTMLElement[]) el.style.order = '';
    return true;
  };
  if (!ctl.current)
    ctl.current = new SortController({
      order: () => cssPreview.current ?? live.current.order,
      preview: (o) => {
        const c = box.current;
        if (!o) {
          if (clearCss()) return true;
          setPreview(null);
          return false;
        }
        if (c && domKeys.current && /(grid|flex)/.test(getComputedStyle(c).display)) {
          cssOrder(c, o, domKeys.current);
          cssPreview.current = o;
          return true;
        }
        setPreview(o);
        return false;
      },
      commit: (o) => {
        // keepDom: the preview's CSS `order` already is the new order, and React renders the same values – leave it
        if (live.current.keepDom) cssPreview.current = null;
        else clearCss();
        saveOrder(live.current.id, o, live.current.natural);
        setPreview(null);
      },
      announce: (n, total) => announceText(tr('core')('Verschoben auf Position {n} von {total}', { n, total })),
      resolve: (c) => resolveItems(c, new Set(live.current.natural), domKeys.current),
      disabled: () => live.current.disabled,
    });
  ctl.current.setHint(t('Pfeiltasten wechseln die Kachel, Alt+Umschalt+Pfeiltasten verschieben sie.'));
  const ref = useCallback((el: HTMLElement | null) => {
    box.current = el;
    ctl.current!.attach(el);
  }, []);
  useLayoutEffect(() => ctl.current!.afterRender());
  useEffect(() => () => ctl.current!.attach(null), []);
  const changed = !!saved && !sameOrder(applied, natural);
  const reset = useCallback(() => resetOrder(id), [id]);
  return { order, ref, changed, reset, domKeys };
}

/** The grid's items: elements with data-sort-key that belong to it, or – for direct children that do not render the
 *  attribute (a component that does not pass it on) – the child at the same position. */
function resolveItems(container: HTMLElement, keys: Set<string>, domKeys: (string | null)[] | null): Map<HTMLElement, string> {
  const map = new Map<HTMLElement, string>();
  if (domKeys) {
    const kids = tiles(container);
    const byIndex = kids.length === domKeys.length;
    kids.forEach((el, i) => {
      const k = el.dataset.sortKey ?? (byIndex ? domKeys[i] : null);
      if (k && keys.has(k)) map.set(el, k);
    });
    return map;
  }
  for (const el of Array.from(container.querySelectorAll<HTMLElement>('[data-sort-key]'))) {
    const k = el.dataset.sortKey!;
    if (keys.has(k) && el.parentElement?.closest('[data-sortable]') === container) map.set(el, k);
  }
  return map;
}

/** Shows `order` (the sortable keys) with CSS `order` on the direct children; children that are not sortable keep their slot. */
function cssOrder(container: HTMLElement, order: string[], domKeys: (string | null)[]) {
  const kids = tiles(container);
  const byIndex = kids.length === domKeys.length;
  const keyOf = kids.map((el, i) => el.dataset.sortKey ?? (byIndex ? domKeys[i] : null));
  const wanted = new Set(order);
  const slot = new Map<string, number>();
  let j = 0;
  keyOf.forEach((k, i) => {
    if (k !== null && wanted.has(k)) slot.set(order[j++], i);
  });
  kids.forEach((el, i) => {
    const k = keyOf[i];
    el.style.order = String(k !== null && slot.has(k) ? slot.get(k) : i);
  });
}

/** The direct children of a grid that are tiles (not the reset link SortableGrid renders inside it). */
const tiles = (container: HTMLElement) => (Array.from(container.children) as HTMLElement[]).filter((el) => !el.hasAttribute('data-sort-reset'));

/**
 * "Reihenfolge zurücksetzen" – only shown once the person arranged the grid themselves. SortableGrid renders it as the
 * grid's last row (full width, after every tile even while previewing), so the layout around the grid never changes.
 */
export function SortReset({ sortable, className }: { sortable: Pick<Sortable, 'changed' | 'reset'>; className?: string }) {
  const t = useT('core');
  if (!sortable.changed) return null;
  return (
    <p className={`sortable-reset${className ? ` ${className}` : ''}`} data-sort-reset="">
      <button type="button" className="linkish" onClick={sortable.reset}>
        {t('Reihenfolge zurücksetzen')}
      </button>
    </p>
  );
}

type GridProps = Omit<HTMLAttributes<HTMLElement>, 'children' | 'id'> & {
  /** The grid's id (see SortableOptions.id). */
  id: string;
  children?: ReactNode;
  /**
   * For tiles with live embeds (plugin iframes): the children stay in their natural DOM order and the saved order is shown
   * with CSS `order` (the grid must be a CSS grid or flex box) – a drop or a keyboard move never moves an iframe in the DOM,
   * which would reload it. The Tab order then follows the natural order.
   */
  keepDom?: boolean;
  /** Keys of children that keep their place (an "add" tile at the end, a heading). */
  pinned?: string[];
  as?: 'div' | 'ul' | 'ol' | 'section';
  disabled?: boolean;
  /** No "Reihenfolge zurücksetzen" in the grid (the page offers it elsewhere). */
  noReset?: boolean;
  [data: `data-${string}`]: string | undefined;
};

interface Entry {
  key: string | null;
  node: ReactNode;
}

/** A grid of tiles the person can arrange: renders its children in the saved order, plus the reset link as its last row when changed. */
export function SortableGrid({ id, children, pinned, as = 'div', disabled, noReset, keepDom, ...rest }: GridProps) {
  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const child of Children.toArray(children)) {
    if (!isValidElement(child) || child.type === Fragment) {
      entries.push({ key: null, node: child });
      continue;
    }
    let k = safeKey(tileKey(child.key));
    for (let n = 2; seen.has(k); n++) k = safeKey(`${tileKey(child.key)}~${n}`);
    seen.add(k);
    entries.push({ key: k, node: child });
  }
  const fixed = new Set(pinned ?? []);
  const isSortable = (e: Entry) => e.key !== null && !fixed.has(e.key);
  const s = useSortable({ id, keys: entries.filter(isSortable).map((e) => e.key!), disabled, keepDom });
  const byKey = new Map(entries.filter(isSortable).map((e) => [e.key!, e]));
  let i = 0;
  const arranged = entries.map((e) => (isSortable(e) ? (byKey.get(s.order[i++]) ?? e) : e));
  const Tag = as as 'div';
  const tag = (e: Entry, extra?: Record<string, unknown>) => {
    if (!isSortable(e) && !extra) return e.node;
    if (!isValidElement(e.node) || e.node.type === Fragment) return e.node;
    const el = e.node as ReactElement<Record<string, unknown>>;
    return cloneElement(el, { ...(isSortable(e) ? { 'data-sort-key': e.key } : {}), ...extra });
  };
  let kids: ReactNode[];
  if (keepDom) {
    // natural DOM order; each child's place in the arranged order as CSS `order` (the reset row's 9999 stays last)
    const place = new Map(arranged.map((e, n) => [e, n]));
    s.domKeys.current = entries.map((e) => (isSortable(e) ? e.key : null));
    kids = entries.map((e) => tag(e, { style: { ...((isValidElement(e.node) && (e.node.props as { style?: object }).style) || {}), order: place.get(e) } }));
  } else {
    s.domKeys.current = arranged.map((e) => (isSortable(e) ? e.key : null));
    kids = arranged.map((e) => tag(e));
  }
  return (
    <Tag ref={s.ref as (el: HTMLDivElement | null) => void} data-sortable="" {...(rest as HTMLAttributes<HTMLDivElement>)}>
      {kids}
      {!noReset && <SortReset sortable={s} />}
    </Tag>
  );
}
