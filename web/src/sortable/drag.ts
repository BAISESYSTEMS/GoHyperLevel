import { moveKey, sameOrder } from '../../../server/services/tile-order';

/**
 * Drag & drop of tiles without handles (docs/theming.md#kacheln-sortieren) – the DOM half of web/src/sortable: pointer
 * (mouse, pen, touch), keyboard, live reflow and auto-scroll for one grid container. React renders the order; this class
 * only asks for a temporary order while dragging (`preview`) and for the final one (`commit`).
 *
 *  - Mouse/pen: the drag starts after 6 px of movement, so a click (on the tile, a link or a button in it) stays a click.
 *    Touch: after a 350 ms long-press without moving, so swiping still scrolls the page; a long-press let go without moving
 *    is still a tap (the click goes through).
 *  - Never from a text field, select, slider, contenteditable, code or a table in a tile (to select and copy it),
 *    video/audio/canvas, [data-nodrag] or an element that handled the press itself.
 *  - The tile lifts and follows the pointer, the others make room (FLIP animation unless prefers-reduced-motion), the page
 *    scrolls near the viewport's (or the scroll area's) edges, Esc puts everything back – and the release that follows is
 *    no click.
 *  - Keyboard: tiles without anything focusable share one tab stop per grid (roving tabindex), the arrow keys move the focus
 *    between tiles; Alt+Shift+←/→ moves the tile one place, ↑/↓ one row, Home/End to the start/end – on the focused tile or
 *    anything in it. The focus stays on the moved tile (also when it is rendered anew in another row).
 */

export interface DragHost {
  /** The sortable keys in the order shown right now (also during a drag). */
  order(): string[];
  /** Show a temporary order (null = back to the saved one). True when it is already in the DOM (CSS `order`), false when
   *  React renders it (afterRender follows from the layout effect). */
  preview(order: string[] | null): boolean;
  /** Save a new order. */
  commit(order: string[]): void;
  /** Tell screen readers where the tile went (1-based). */
  announce(position: number, total: number): void;
  /** The item elements of the grid and their keys, for the DOM as it is now. */
  resolve(container: HTMLElement): Map<HTMLElement, string>;
  disabled(): boolean;
}

/** Where a drag never starts: things that take text or a value, code to select and copy, media with their own controls,
 *  and whatever opts out. */
const NO_DRAG = 'input, textarea, select, option, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [data-nodrag], [draggable="true"], .cm-editor, .ProseMirror, pre, code, kbd, .codebox, video, audio, canvas, [role="slider"]';
const FOCUSABLE = 'a[href], button, input, select, textarea, summary, iframe, [tabindex]:not([tabindex="-1"]), [contenteditable=""], [contenteditable="true"]';
/** Inside a tile, but never a drag: data tables (their text is selected and copied, also on touch). */
const TEXT_BLOCK = 'table';
const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
const MOVE_PX = 6;
const TOUCH_SLOP = 8;
const LONG_PRESS_MS = 350;
const ANIM_MS = 200;
const EASE = 'cubic-bezier(.2,.8,.2,1)';
const HINT_ID = 'sortable-hint';
const LIVE_ID = 'sortable-live';

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const canAnimate = (el: Element) => typeof (el as HTMLElement).animate === 'function' && !reducedMotion();

/** The one visually hidden help text all tiles that got a tab stop point to. */
export function ensureHint(text: string): string {
  if (typeof document === 'undefined') return HINT_ID;
  let el = document.getElementById(HINT_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = HINT_ID;
    el.className = 'sortable-sr';
    document.body.appendChild(el);
  }
  if (el.textContent !== text) el.textContent = text;
  return HINT_ID;
}

/**
 * The polite live region for "verschoben auf Position 3 von 8" – created as soon as the first grid attaches: screen readers
 * ignore changes to a live region that was only just inserted, so the first move would go unheard.
 */
export function ensureLive(): HTMLElement | null {
  if (typeof document === 'undefined' || !document.body) return null;
  let el = document.getElementById(LIVE_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = LIVE_ID;
    el.className = 'sortable-sr';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    document.body.appendChild(el);
  }
  return el;
}

let announceTimer: ReturnType<typeof setTimeout> | undefined;
export function announceText(text: string) {
  const el = ensureLive();
  if (!el) return;
  // A changed text is announced; the same text twice in a row would not be, so clear first – and give the screen reader a
  // moment to notice the empty region.
  el.textContent = '';
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => (el.textContent = text), 100);
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (/(auto|scroll|overlay)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 1) return n;
  }
  return null;
}

type Phase = 'idle' | 'pending' | 'drag';

export class SortController {
  private container: HTMLElement | null = null;
  private items = new Map<HTMLElement, string>();
  private marked = new Set<HTMLElement>();
  private phase: Phase = 'idle';
  private pointerId = -1;
  private pointerType = '';
  private startX = 0;
  private startY = 0;
  private px = 0;
  private py = 0;
  private dragEl: HTMLElement | null = null;
  private dragKey = '';
  private grabDX = 0;
  private grabDY = 0;
  private tx = 0;
  private ty = 0;
  private original: string[] = [];
  private pressTimer: ReturnType<typeof setTimeout> | undefined;
  private raf = 0;
  private slot: HTMLDivElement | null = null;
  private scroller: HTMLElement | null = null;
  private before: Map<HTMLElement, DOMRect> | null = null;
  private animating = new Set<HTMLElement>();
  /** After a keyboard move: what had the focus – the element, and to find it again when the tile is rendered anew (another
   *  row, another parent): the tile's key and which focusable inside it (-1 = the tile itself). */
  private refocus: { el: HTMLElement; key: string; child: number } | null = null;
  private lastTarget: HTMLElement | null = null;
  private hint = '';
  /** The tile with the grid's one tab stop (the last focused, see rove). */
  private roverKey: string | null = null;
  /** Moved beyond the touch slop since the drag started (a long-press let go in place is a tap, not a drop). */
  private travelled = false;
  private stopSwallow: (() => void) | null = null;

  constructor(private host: DragHost) {}

  // --- wiring ----------------------------------------------------------------------------------------------------------

  attach(el: HTMLElement | null) {
    if (el === this.container) return;
    if (this.container) {
      this.cancel();
      this.container.removeEventListener('pointerdown', this.onDown);
      this.container.removeEventListener('keydown', this.onKey);
      this.container.removeEventListener('dragstart', this.onNativeDrag);
      this.container.removeEventListener('touchmove', this.onTouchMove);
      this.container.removeEventListener('contextmenu', this.onContext);
      this.container.removeEventListener('focusin', this.onFocus);
      this.unmarkAll();
    }
    this.container = el;
    if (el) {
      ensureLive();
      el.addEventListener('pointerdown', this.onDown);
      el.addEventListener('keydown', this.onKey);
      el.addEventListener('focusin', this.onFocus);
      el.addEventListener('dragstart', this.onNativeDrag);
      // not passive: once a long-press picked a tile up, the finger moves the tile instead of the page
      el.addEventListener('touchmove', this.onTouchMove, { passive: false });
      el.addEventListener('contextmenu', this.onContext);
    }
  }

  /** The help text for tiles that get a tab stop (set once per language). */
  setHint(text: string) {
    this.hint = text;
  }

  /** After every render: learn the item elements again, run the reflow animation, keep the lifted tile under the pointer. */
  afterRender() {
    const c = this.container;
    if (!c) return;
    this.items = this.host.disabled() ? new Map() : this.host.resolve(c);
    this.mark();
    if (this.before) {
      const before = this.before;
      this.before = null;
      for (const [el, r0] of before) {
        if (!el.isConnected) continue;
        this.stopAnim(el);
        const r1 = el.getBoundingClientRect();
        const dx = r0.left + r0.width / 2 - (r1.left + r1.width / 2);
        const dy = r0.top + r0.height / 2 - (r1.top + r1.height / 2);
        if (Math.abs(dx) + Math.abs(dy) < 1 || !canAnimate(el)) continue;
        const a = el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0px, 0px)' }], { duration: ANIM_MS, easing: EASE });
        a.id = 'sortable';
        this.animating.add(el);
        const done = () => this.animating.delete(el);
        a.onfinish = done;
        a.oncancel = done;
      }
    }
    if (this.phase === 'drag' && this.dragEl) {
      // the tile may have been re-created (a re-render with a new element): follow the key
      if (!this.dragEl.isConnected) {
        const again = [...this.items].find(([, k]) => k === this.dragKey)?.[0];
        if (again) this.lift(again);
      }
      this.position();
    }
    if (this.refocus) {
      const { el, key, child } = this.refocus;
      this.refocus = null;
      // React could not move the tile (it went into another parent – a Fokus row) and rendered it anew: find it by its key
      let target: HTMLElement | null = el.isConnected ? el : null;
      if (!target) {
        const item = this.itemByKey(key);
        if (item) target = child < 0 ? item : (item.querySelectorAll<HTMLElement>(FOCUSABLE)[child] ?? item);
      }
      if (target) {
        if (document.activeElement !== target) target.focus({ preventScroll: true });
        target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      }
    }
  }

  /** Item elements get a marker (cursor) and – when nothing in them can take focus – a place in the grid's one tab stop. */
  private mark() {
    const now = new Set(this.items.keys());
    for (const el of this.marked) if (!now.has(el)) this.unmark(el);
    const hint = this.hint ? ensureHint(this.hint) : '';
    for (const el of now) {
      if (this.marked.has(el)) continue;
      el.setAttribute('data-sort-item', '');
      if (!el.hasAttribute('tabindex') && !el.matches(FOCUSABLE) && !el.querySelector(FOCUSABLE)) {
        el.setAttribute('tabindex', '-1');
        el.setAttribute('data-sort-tab', '');
        if (hint && !el.hasAttribute('aria-describedby')) el.setAttribute('aria-describedby', hint);
      }
      this.marked.add(el);
    }
    this.rove();
  }

  /**
   * Roving tabindex: of the tiles that got a tab stop from us (key figures and the like, nothing focusable inside), only one
   * is in the Tab order – the one focused last, or the first in the grid's order – so Tab passes a row of key figures in one
   * step; the arrow keys move between them (onKey).
   */
  private rove() {
    const tabs = [...this.items].filter(([el]) => el.hasAttribute('data-sort-tab'));
    if (!tabs.length) return;
    let current = tabs.find(([, k]) => k === this.roverKey)?.[0];
    if (!current) {
      const order = this.host.order();
      const rank = (k: string) => (order.indexOf(k) + order.length + 1) % (order.length + 1);
      current = tabs.reduce((a, b) => (rank(b[1]) < rank(a[1]) ? b : a))[0];
    }
    for (const [el] of tabs) {
      const want = el === current ? '0' : '-1';
      if (el.getAttribute('tabindex') !== want) el.setAttribute('tabindex', want);
    }
  }

  private onFocus = (e: FocusEvent) => {
    const el = e.target instanceof HTMLElement ? e.target : null;
    if (!el || !this.items.has(el) || !el.hasAttribute('data-sort-tab')) return;
    const key = this.items.get(el)!;
    if (key === this.roverKey && el.getAttribute('tabindex') === '0') return;
    this.roverKey = key;
    this.rove();
  };

  private unmark(el: HTMLElement) {
    el.removeAttribute('data-sort-item');
    if (el.hasAttribute('data-sort-tab')) {
      el.removeAttribute('data-sort-tab');
      el.removeAttribute('tabindex');
      if (el.getAttribute('aria-describedby') === HINT_ID) el.removeAttribute('aria-describedby');
    }
    this.marked.delete(el);
  }

  private unmarkAll() {
    for (const el of [...this.marked]) this.unmark(el);
  }

  // --- helpers ---------------------------------------------------------------------------------------------------------

  private itemByKey(key: string): HTMLElement | undefined {
    for (const [el, k] of this.items) if (k === key) return el;
    return undefined;
  }

  /** The item element an event target belongs to (the nearest one of this grid, not of a grid nested in a tile). */
  private itemOf(node: EventTarget | Element | null): HTMLElement | null {
    let n = node instanceof Element ? node : null;
    while (n && n !== this.container) {
      if (n instanceof HTMLElement && this.items.has(n)) return n;
      n = n.parentElement;
    }
    return null;
  }

  private stopAnim(el: HTMLElement) {
    for (const a of el.getAnimations?.() ?? []) if (a.id === 'sortable') a.cancel();
    this.animating.delete(el);
  }

  private snapshot(includeDragged = false) {
    const m = new Map<HTMLElement, DOMRect>();
    for (const el of this.items.keys()) if (includeDragged || el !== this.dragEl) m.set(el, el.getBoundingClientRect());
    this.before = m;
  }

  /** The dragged tile's place in the layout (where it sits without the lift). */
  private naturalRect(): { cx: number; cy: number; w: number; h: number } {
    const el = this.dragEl!;
    const r = el.getBoundingClientRect();
    return { cx: r.left + r.width / 2 - this.tx, cy: r.top + r.height / 2 - this.ty, w: el.offsetWidth || r.width, h: el.offsetHeight || r.height };
  }

  // --- pointer ---------------------------------------------------------------------------------------------------------

  private onDown = (e: PointerEvent) => {
    if (this.phase !== 'idle' || this.host.disabled()) return;
    // a grid nested in a tile handles its own tiles first
    if ((e as any).__sortHandled) return;
    if (e.defaultPrevented || !e.isPrimary) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const target = e.target as Element | null;
    if (!target || target.closest(NO_DRAG)) return;
    const item = this.itemOf(target);
    if (!item || this.items.size < 2) return;
    // a table inside the tile (not one the grid itself sits in): its text is for selecting and copying
    const block = target.closest(TEXT_BLOCK);
    if (block && block !== item && item.contains(block)) return;
    (e as any).__sortHandled = true;
    this.stopSwallow?.();
    this.travelled = false;
    this.phase = 'pending';
    this.pointerId = e.pointerId;
    this.pointerType = e.pointerType;
    this.startX = this.px = e.clientX;
    this.startY = this.py = e.clientY;
    this.dragEl = item;
    this.dragKey = this.items.get(item)!;
    window.addEventListener('pointermove', this.onMove, true);
    window.addEventListener('pointerup', this.onUp, true);
    window.addEventListener('pointercancel', this.onCancelEvent, true);
    if (e.pointerType === 'touch') this.pressTimer = setTimeout(() => this.phase === 'pending' && this.begin(), LONG_PRESS_MS);
  };

  private onMove = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    // the mouse button was let go outside the window
    if (this.pointerType === 'mouse' && e.buttons === 0) return this.phase === 'drag' ? this.drop() : this.reset();
    this.px = e.clientX;
    this.py = e.clientY;
    if (this.phase === 'pending') {
      const d = Math.hypot(this.px - this.startX, this.py - this.startY);
      if (this.pointerType === 'touch') {
        // moved before the long-press: the person scrolls
        if (d > TOUCH_SLOP) this.reset();
        return;
      }
      if (d < MOVE_PX) return;
      this.begin();
    }
    if (this.phase === 'drag') {
      e.preventDefault();
      if (!this.travelled && Math.hypot(this.px - this.startX, this.py - this.startY) > TOUCH_SLOP) this.travelled = true;
      this.position();
      this.hitTest();
    }
  };

  private onUp = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    if (this.phase === 'drag') this.drop();
    else this.reset();
  };

  private onCancelEvent = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    this.cancel();
  };

  private onTouchMove = (e: TouchEvent) => {
    if (this.phase === 'drag' && e.cancelable) e.preventDefault();
  };

  private onContext = (e: Event) => {
    // the long-press that picks a tile up must not open the browser's menu
    if (this.phase !== 'idle' && this.pointerType === 'touch') e.preventDefault();
  };

  private onNativeDrag = (e: DragEvent) => {
    // links and images in a tile would start the browser's own drag and swallow ours
    if (this.itemOf(e.target) && !(e.target as Element).closest?.('[draggable="true"]')) e.preventDefault();
  };

  private onEscape = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || this.phase !== 'drag') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.cancel();
    // the button (or finger) is still down: letting go over the tile would click it, though the person just cancelled
    this.swallowClick(true);
  };

  private onScroll = () => {
    if (this.phase !== 'drag') return;
    this.position();
    this.hitTest();
  };

  /**
   * Eats the click the current press ends with – it ended a drag, it is no click on the tile or a link in it. Right away (a
   * drop: the click follows the release that caused it) or, after Esc while the pointer is still down, the click that
   * follows the release; a new press or another key ends it in any case (Enter on a button is a click of its own).
   */
  private swallowClick(afterRelease: boolean) {
    this.stopSwallow?.();
    let t: ReturnType<typeof setTimeout> | undefined;
    const eat = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      stop();
    };
    const soon = () => {
      clearTimeout(t);
      t = setTimeout(stop, 60);
    };
    const key = (e: KeyboardEvent) => e.key !== 'Escape' && stop();
    const stop = () => {
      clearTimeout(t);
      window.removeEventListener('click', eat, true);
      window.removeEventListener('pointerup', soon, true);
      window.removeEventListener('pointercancel', stop, true);
      window.removeEventListener('pointerdown', stop, true);
      window.removeEventListener('keydown', key, true);
      if (this.stopSwallow === stop) this.stopSwallow = null;
    };
    this.stopSwallow = stop;
    window.addEventListener('click', eat, true);
    if (!afterRelease) return soon();
    window.addEventListener('pointerup', soon, true);
    window.addEventListener('pointercancel', stop, true);
    window.addEventListener('pointerdown', stop, true);
    window.addEventListener('keydown', key, true);
  }

  // --- drag ------------------------------------------------------------------------------------------------------------

  private begin() {
    const el = this.dragEl;
    if (!el || !this.container) return this.reset();
    clearTimeout(this.pressTimer);
    this.phase = 'drag';
    // a mouse or pen only gets here by moving; a finger by holding still
    this.travelled = this.pointerType !== 'touch';
    this.original = this.host.order();
    const r = el.getBoundingClientRect();
    this.grabDX = this.startX - (r.left + r.width / 2);
    this.grabDY = this.startY - (r.top + r.height / 2);
    this.tx = this.ty = 0;
    this.lastTarget = null;
    this.lift(el);
    document.documentElement.classList.add('sortable-dragging');
    window.getSelection?.()?.removeAllRanges();
    window.addEventListener('keydown', this.onEscape, true);
    window.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
    try {
      // keeps the pointer's events (and its release) with the grid, even outside the window
      this.container.setPointerCapture(this.pointerId);
    } catch {
      /* the pointer is already gone */
    }
    if (this.pointerType === 'touch') navigator.vibrate?.(8);
    this.scroller = scrollParent(this.container);
    this.slot = document.createElement('div');
    this.slot.className = 'sortable-slot';
    this.slot.style.borderRadius = getComputedStyle(el).borderRadius;
    document.body.appendChild(this.slot);
    this.position();
    this.raf = requestAnimationFrame(this.tick);
  }

  private lift(el: HTMLElement) {
    if (this.dragEl && this.dragEl !== el) this.unlift(this.dragEl);
    this.dragEl = el;
    this.stopAnim(el);
    // z-index needs a positioned box (grid and flex items have one anyway)
    if (getComputedStyle(el).position === 'static') {
      el.style.position = 'relative';
      el.setAttribute('data-sort-pos', '');
    }
    el.classList.add('sortable-lifted');
  }

  private unlift(el: HTMLElement) {
    el.classList.remove('sortable-lifted');
    el.style.translate = '';
    if (el.hasAttribute('data-sort-pos')) {
      el.style.position = '';
      el.removeAttribute('data-sort-pos');
    }
  }

  private position() {
    const el = this.dragEl;
    if (!el) return;
    const n = this.naturalRect();
    this.tx = this.px - this.grabDX - n.cx;
    this.ty = this.py - this.grabDY - n.cy;
    el.style.translate = `${this.tx}px ${this.ty}px`;
    if (this.slot) Object.assign(this.slot.style, { left: `${n.cx - n.w / 2}px`, top: `${n.cy - n.h / 2}px`, width: `${n.w}px`, height: `${n.h}px` });
  }

  /**
   * Over another tile → the dragged tile takes its place and the tiles in between move one place up or down. The tile it
   * just swapped with does not count again until the pointer has left it (tiles of different sizes would swap back and forth),
   * nor does a tile that is still gliding to its new place.
   */
  private hitTest() {
    const el = this.dragEl;
    if (!el || !this.container) return;
    const order = this.host.order();
    const from = order.indexOf(this.dragKey);
    if (from < 0) return;
    const hit = document.elementFromPoint(this.px, this.py);
    const target = this.itemOf(hit);
    if (target !== this.lastTarget) this.lastTarget = null;
    if (target && target !== el) {
      if (target === this.lastTarget || this.animating.has(target)) return;
      const to = order.indexOf(this.items.get(target)!);
      if (to < 0 || to === from) return;
      this.lastTarget = target;
      this.apply(moveKey(order, from, to));
      return;
    }
    if (target) return;
    // in the free space after the last tile (rest of the last row, or below it) → to the end
    const c = this.container.getBoundingClientRect();
    if (this.px < c.left || this.px > c.right || this.py < c.top || this.py > c.bottom + 24) return;
    const lastKey = order[order.length - 1];
    if (lastKey === this.dragKey) return;
    const last = [...this.items].find(([, k]) => k === lastKey)?.[0];
    if (!last || this.animating.has(last)) return;
    const lr = last.getBoundingClientRect();
    if (this.py > lr.bottom || (this.py >= lr.top && this.px > lr.right)) this.apply(moveKey(order, from, order.length - 1));
  }

  private apply(next: string[]) {
    this.snapshot();
    if (this.host.preview(next)) this.afterRender();
  }

  private tick = () => {
    if (this.phase !== 'drag') return;
    const s = this.scroller;
    const view = s ? s.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const top = Math.max(0, view.top);
    const bottom = Math.min(window.innerHeight, view.bottom);
    const edge = Math.min(64, (bottom - top) / 4);
    let dy = 0;
    if (this.py < top + edge) dy = -Math.ceil(Math.min(1, (top + edge - this.py) / edge) ** 2 * 18);
    else if (this.py > bottom - edge) dy = Math.ceil(Math.min(1, (this.py - (bottom - edge)) / edge) ** 2 * 18);
    if (dy) {
      const before = s ? s.scrollTop : window.scrollY;
      if (s) s.scrollTop += dy;
      else window.scrollBy(0, dy);
      if ((s ? s.scrollTop : window.scrollY) !== before) {
        this.position();
        this.hitTest();
      }
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private drop() {
    const order = this.host.order();
    const changed = !sameOrder(order, this.original);
    const travelled = this.travelled;
    this.finish();
    if (changed) {
      this.host.commit(order);
      this.host.announce(order.indexOf(this.dragKey) + 1, order.length);
    } else if (this.host.preview(null)) this.afterRender();
    // The click that ends a drag is not a click on the tile – but a long-press let go in place (a slow tap on a card, a
    // link, a button) is: the OS still turns it into a click, and that one goes through.
    if (changed || travelled) this.swallowClick(false);
  }

  /** Esc, a cancelled pointer, or the grid going away: everything back where it was. */
  cancel() {
    if (this.phase === 'drag') {
      this.finish();
      if (this.host.preview(null)) this.afterRender();
    } else this.reset();
  }

  /** Puts the lifted tile down: it glides from under the pointer into its place, the others settle. */
  private finish() {
    const el = this.dragEl;
    this.snapshot(true);
    if (el) this.unlift(el);
    this.reset();
    // React may render nothing new (dropped where it came from): run the settle animation anyway
    requestAnimationFrame(() => this.afterRender());
  }

  private reset() {
    clearTimeout(this.pressTimer);
    cancelAnimationFrame(this.raf);
    window.removeEventListener('pointermove', this.onMove, true);
    window.removeEventListener('pointerup', this.onUp, true);
    window.removeEventListener('pointercancel', this.onCancelEvent, true);
    window.removeEventListener('keydown', this.onEscape, true);
    window.removeEventListener('scroll', this.onScroll, true);
    try {
      if (this.container?.hasPointerCapture?.(this.pointerId)) this.container.releasePointerCapture(this.pointerId);
    } catch {
      /* nothing captured */
    }
    document.documentElement.classList.remove('sortable-dragging');
    this.slot?.remove();
    this.slot = null;
    if (this.dragEl) this.unlift(this.dragEl);
    this.phase = 'idle';
    this.dragEl = null;
    this.pointerId = -1;
  }

  // --- keyboard --------------------------------------------------------------------------------------------------------

  private onKey = (e: KeyboardEvent) => {
    if (!ARROWS.includes(e.key) || e.ctrlKey || e.metaKey || this.phase !== 'idle') return;
    if (!e.altKey && !e.shiftKey) return this.onArrow(e);
    if (!e.altKey || !e.shiftKey || this.host.disabled()) return;
    const target = e.target as Element | null;
    if (!target || target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
    const item = this.itemOf(target);
    if (!item) return;
    const key = this.items.get(item)!;
    const order = this.host.order();
    const from = order.indexOf(key);
    if (from < 0) return;
    let to = from;
    if (e.key === 'ArrowLeft') to = from - 1;
    else if (e.key === 'ArrowRight') to = from + 1;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = order.length - 1;
    else {
      const cols = this.columns();
      to = e.key === 'ArrowUp' ? from - cols : from + cols;
    }
    e.preventDefault();
    e.stopPropagation();
    to = Math.max(0, Math.min(order.length - 1, to));
    if (to === from) return;
    const next = moveKey(order, from, to);
    this.snapshot(true);
    const focused = target instanceof HTMLElement ? target : item;
    this.refocus = { el: focused, key, child: focused === item ? -1 : Array.from(item.querySelectorAll(FOCUSABLE)).indexOf(focused) };
    this.host.commit(next);
    this.host.announce(to + 1, next.length);
  };

  /** Plain arrow keys on a tile that has our tab stop (roving tabindex): the focus goes to the neighbouring tile. */
  private onArrow(e: KeyboardEvent) {
    const el = e.target instanceof HTMLElement ? e.target : null;
    if (!el || !this.items.has(el) || !el.hasAttribute('data-sort-tab')) return;
    const order = this.host.order();
    const from = order.indexOf(this.items.get(el)!);
    if (from < 0) return;
    const cols = e.key === 'ArrowUp' || e.key === 'ArrowDown' ? this.columns() : 1;
    let to = from;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = from - cols;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = from + cols;
    else to = e.key === 'Home' ? 0 : order.length - 1;
    e.preventDefault();
    e.stopPropagation();
    to = Math.max(0, Math.min(order.length - 1, to));
    const next = this.itemByKey(order[to]);
    if (!next || next === el) return;
    const focusable = next.hasAttribute('data-sort-tab') || next.matches(FOCUSABLE) ? next : next.querySelector<HTMLElement>(FOCUSABLE);
    focusable?.focus();
  }

  /** Tiles per row: how many share the first tile's row. */
  private columns(): number {
    const tops = [...this.items.keys()].map((el) => el.offsetTop);
    if (!tops.length) return 1;
    const first = Math.min(...tops);
    return Math.max(1, tops.filter((t) => Math.abs(t - first) < 4).length);
  }
}
