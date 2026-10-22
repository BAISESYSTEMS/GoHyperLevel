import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { reading, limitsAt, type Bp, type Cell, type Limits, type Placed } from '../../../server/services/boards-layout';
import { Icon } from '../icons';
import { GAP, ROW_H, arrange, cellPx, cellsOf, colWidth, describeCell, heightPx, rowsPx, stackStep } from './layout';
import type { Widget } from './types';

/**
 * The board's grid: pointer-based drag and resize (no library), the same `settle` as the server so the picture while
 * dragging is the picture that is saved, smooth movement (cells glide to their new places; the dragged one follows the
 * pointer), auto-scroll near the edges, keyboard (Leertaste greift, Pfeile bewegen, Umschalt+Pfeile ändern die Größe,
 * Leertaste legt ab, Esc bricht ab) and – on a phone – a single column with up/down buttons.
 */

export interface CardPart {
  /** px size of the card */
  width: number;
  height: number;
  /** the grip (or, on a phone, the up/down buttons) and the corner to resize by */
  handle: ReactNode;
  resizer: ReactNode;
  lifted: boolean;
  /** a short text for the card's aria description while it is grabbed */
  position: string;
}

interface Drag {
  id: string;
  mode: 'move' | 'size';
  kb: boolean;
  origin: Cell;
  dx: number;
  dy: number;
  /** where it will rest once dropped (the server lets every card rise as far as it can) */
  target: Cell;
  /** the keyboard's own position: it can be further down than the resting place, so a card can be moved below another one */
  cursor: Cell;
  cells: Placed[];
}

const scrollParent = (el: HTMLElement | null): HTMLElement | null => {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
};

export function Grid({ widgets, bp, width, edit, limits, titleOf, onCommit, render }: { widgets: Widget[]; bp: Bp; width: number; edit: boolean; limits: (type: string) => Limits; titleOf: (w: Widget) => string; onCommit: (ops: Record<string, unknown>[], cells: Placed[]) => void; render: (w: Widget, part: CardPart) => ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const base = useMemo(() => cellsOf(widgets, bp), [widgets, bp]);
  const colW = colWidth(width, bp);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const start = useRef({ x: 0, y: 0, scroll: 0 });
  const pointer = useRef({ x: 0, y: 0 });
  const frame = useRef(0);
  const [said, setSaid] = useState('');
  // what the pointer handlers see (they are set up once per drag)
  const live = useRef({ base, bp, colW, limits, widgets, onCommit, titleOf });
  live.current = { base, bp, colW, limits, widgets, onCommit, titleOf };

  const lim = (id: string) => {
    const w = live.current.widgets.find((x) => x.id === id);
    return limitsAt(live.current.limits(w?.type ?? ''), live.current.bp);
  };
  const set = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };

  /** What a finished drag changes: a move, a resize or both (the keyboard can do both in one go). */
  const commit = (d: Drag) => {
    const b = live.current.bp;
    const o = d.origin;
    const t = d.target;
    const ops: Record<string, unknown>[] = [];
    if (t.x !== o.x || t.y !== o.y) ops.push({ op: 'move', id: d.id, x: t.x, y: t.y, bp: b });
    if (t.w !== o.w || t.h !== o.h) ops.push({ op: 'resize', id: d.id, w: t.w, h: t.h, bp: b });
    if (ops.length) live.current.onCommit(ops, d.cells);
  };

  // --- pointer ---------------------------------------------------------------------------------------------------------
  const recompute = () => {
    const d = dragRef.current;
    if (!d || d.kb) return;
    const { base: cells, bp: b, colW: cw } = live.current;
    const sc = scrollParent(rootRef.current);
    const dScroll = (sc?.scrollTop ?? window.scrollY) - start.current.scroll;
    const dx = pointer.current.x - start.current.x;
    const dy = pointer.current.y - start.current.y + dScroll;
    const gx = Math.round(dx / (cw + GAP));
    const gy = Math.round(dy / (ROW_H + GAP));
    const o = d.origin;
    const cur: Cell = d.mode === 'move' ? { ...o, x: o.x + gx, y: o.y + gy } : { ...o, w: o.w + gx, h: o.h + gy };
    const next = arrange(cells, d.id, cur, o, b, lim(d.id));
    set({ ...d, dx, dy, cells: next, target: next.find((c) => c.id === d.id)! });
  };

  // near the top or bottom edge the page scrolls by itself while a card is held
  const autoscroll = () => {
    const d = dragRef.current;
    if (!d || d.kb) return;
    const sc = scrollParent(rootRef.current);
    const rect = sc ? sc.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const y = pointer.current.y;
    const speed = y < rect.top + 70 ? -Math.ceil((rect.top + 70 - y) / 5) : y > rect.bottom - 70 ? Math.ceil((y - (rect.bottom - 70)) / 5) : 0;
    if (speed) {
      if (sc) sc.scrollTop += speed;
      else window.scrollBy(0, speed);
      recompute();
    }
    frame.current = requestAnimationFrame(autoscroll);
  };

  const stop = useRef<(() => void) | null>(null);
  const begin = (e: ReactPointerEvent, id: string, mode: 'move' | 'size') => {
    if (!edit || live.current.bp === 'sm' || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const cell = live.current.base.find((c) => c.id === id);
    if (!cell) return;
    stop.current?.();
    const sc = scrollParent(rootRef.current);
    start.current = { x: e.clientX, y: e.clientY, scroll: sc?.scrollTop ?? window.scrollY };
    pointer.current = { x: e.clientX, y: e.clientY };
    const onMove = (ev: PointerEvent) => {
      pointer.current = { x: ev.clientX, y: ev.clientY };
      recompute();
    };
    const end = (cancel: boolean) => {
      stop.current?.();
      const d = dragRef.current;
      set(null);
      if (d && !cancel) commit(d);
    };
    const onUp = () => end(false);
    const onCancel = () => end(true);
    stop.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      cancelAnimationFrame(frame.current);
      stop.current = null;
    };
    set({ id, mode, kb: false, origin: cell, dx: 0, dy: 0, target: cell, cursor: cell, cells: live.current.base });
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    frame.current = requestAnimationFrame(autoscroll);
  };

  useEffect(() => () => stop.current?.(), []);

  // --- keyboard ----------------------------------------------------------------------------------------------------------
  const say = useCallback((id: string, text: string) => setSaid(`${live.current.titleOf(live.current.widgets.find((w) => w.id === id)!)}: ${text}`), []);
  const key = (e: ReactKeyboardEvent, id: string) => {
    if (!edit || live.current.bp === 'sm') return;
    const d = dragRef.current;
    const b = live.current.bp;
    if (!d?.kb) {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        const cell = live.current.base.find((c) => c.id === id)!;
        set({ id, mode: 'move', kb: true, origin: cell, dx: 0, dy: 0, target: cell, cursor: cell, cells: live.current.base });
        say(id, `aufgenommen. Pfeiltasten verschieben, Umschalt und Pfeiltasten ändern die Größe, Leertaste legt ab, Escape bricht ab. Jetzt ${describeCell(cell, b)}.`);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      set(null);
      say(id, 'abgebrochen.');
      return;
    }
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      set(null);
      commit(d);
      say(id, `abgelegt. ${describeCell(d.target, b)}.`);
      return;
    }
    const dir = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[e.key];
    if (!dir) return;
    e.preventDefault();
    const { base: from } = live.current;
    const place = (cur: Cell) => {
      const cells = arrange(from, id, cur, d.origin, b, lim(id));
      return { cells, target: cells.find((c) => c.id === id)! };
    };
    const cur = d.cursor;
    let next: Cell = cur;
    if (e.shiftKey) next = { ...cur, w: cur.w + dir[0], h: cur.h + dir[1] };
    else if (dir[0]) next = { ...cur, x: cur.x + dir[0] };
    else {
      // Up and down jump to the next place where the card really lands differently (it cannot rest below free space).
      const last = Math.max(...from.map((c) => c.y + c.h)) + cur.h;
      let y = cur.y + dir[1];
      while (y >= 0 && y <= last && place({ ...cur, y }).target.y === d.target.y) y += dir[1];
      next = { ...cur, y: Math.min(last, Math.max(0, y)) };
    }
    const res = place(next);
    // the cursor keeps the clamped size and column; the row stays where it was asked for
    set({ ...d, cursor: { ...next, x: res.target.x, w: res.target.w, h: res.target.h }, cells: res.cells, target: res.target });
    say(id, describeCell(res.target, b));
  };

  // --- render ----------------------------------------------------------------------------------------------------------------
  const cells = drag?.cells ?? base;
  const rows = Math.max(1, ...cells.map((c) => c.y + c.h));
  const stack = bp === 'sm';
  const byId = new Map(widgets.map((w) => [w.id, w]));
  const grip = (w: Widget, lifted: boolean): ReactNode => {
    if (!edit) return null;
    if (stack) {
      const order = reading(cells);
      const i = order.findIndex((c) => c.id === w.id);
      const move = (dir: -1 | 1) => {
        const next = stackStep(cells, w.id, dir);
        if (next === cells) return;
        live.current.onCommit([{ op: 'move', id: w.id, y: i + dir, bp: 'sm' }], next);
        say(w.id, `Platz ${i + dir + 1} von ${order.length}`);
      };
      return (
        <span className="bd-stackbtns">
          <button type="button" className="bd-iconbtn" onClick={() => move(-1)} disabled={i <= 0} aria-label={`${titleOf(w)} nach oben`}>
            <Icon name="up" size={15} />
          </button>
          <button type="button" className="bd-iconbtn" onClick={() => move(1)} disabled={i >= order.length - 1} aria-label={`${titleOf(w)} nach unten`}>
            <Icon name="down" size={15} />
          </button>
        </span>
      );
    }
    return (
      <button
        type="button"
        className={`bd-grip${lifted ? ' on' : ''}`}
        onPointerDown={(e) => begin(e, w.id, 'move')}
        onKeyDown={(e) => key(e, w.id)}
        onBlur={() => dragRef.current?.kb && dragRef.current.id === w.id && set(null)}
        aria-label={`${titleOf(w)} verschieben: Leertaste zum Aufnehmen, dann Pfeiltasten (Umschalt = Größe), Leertaste zum Ablegen`}
        aria-pressed={lifted}
        title="Ziehen zum Verschieben"
      >
        <Icon name="grip" size={16} />
      </button>
    );
  };
  const resizer = (w: Widget): ReactNode => (edit && !stack ? <span className="bd-resize" onPointerDown={(e) => begin(e, w.id, 'size')} aria-hidden="true" title="Ziehen zum Vergrößern" /> : null);

  const ghost = drag && !stack ? cellPx(drag.target, colW) : null;
  const items = stack ? reading(cells) : cells;
  return (
    <div ref={rootRef} className={`bd-grid bd-${bp}${edit ? ' edit' : ''}${drag ? ' dragging' : ''}`} style={stack || width <= 0 ? undefined : { height: heightPx(rows) }} data-tour="board-grid">
      {ghost && <div className="bd-ghost" style={{ transform: `translate(${ghost.left}px, ${ghost.top}px)`, width: ghost.width, height: ghost.height }} aria-hidden="true" />}
      {width > 0 &&
        items.map((c) => {
          const w = byId.get(c.id);
          if (!w) return null;
          const held = drag?.id === c.id;
          const px = cellPx(c, colW);
          let style: CSSProperties;
          let size = { width: px.width, height: px.height };
          if (stack) {
            size = { width, height: rowsPx(c.h) };
            style = { height: size.height };
          } else if (held && !drag!.kb) {
            const o = cellPx(drag!.origin, colW);
            if (drag!.mode === 'move') style = { transform: `translate(${o.left + drag!.dx}px, ${o.top + drag!.dy}px)`, width: o.width, height: o.height };
            else {
              size = { width: Math.max(colW, o.width + drag!.dx), height: Math.max(ROW_H, o.height + drag!.dy) };
              style = { transform: `translate(${o.left}px, ${o.top}px)`, ...size };
            }
          } else style = { transform: `translate(${px.left}px, ${px.top}px)`, width: px.width, height: px.height };
          return (
            <div key={c.id} className={`bd-cell${held ? ' held' : ''}${held && drag!.kb ? ' kb' : ''}`} style={style} data-widget={w.id}>
              {render(w, { ...size, handle: grip(w, held), resizer: resizer(w), lifted: held, position: describeCell(c, bp) })}
            </div>
          );
        })}
      <div className="sr-only" aria-live="assertive" role="status">
        {said}
      </div>
    </div>
  );
}
