import './canvas.css';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon, type IconName } from '../icons';
import { useT } from '../i18n';
import { ActionPicker, branchesOf, type Catalog } from '../pages/WorkflowTools';
import type { Issue } from '../../../server/services/workflow-validate';
import type { CanvasNote, WorkflowLayout } from '../../../server/services/workflow-layout';
import { PauseSwitch, PopMenu, isMac, useIssueText, useStepMenu, type MenuItem, type StepOps } from './tools';
import { KeysHelp, Minimap, Note, StepDrawer, TriggerDrawer, type View } from './WorkflowCanvasParts';
import { countSteps } from './clipboard';
import { layoutFlow, nearestNode, type LNode } from './layout';
import { findStep, newId, slotAfter, updateStep, type Slot, type Step } from './model';
import { stepStats } from './stats';

/**
 * The visual workflow canvas ("Advanced Builder"): renders and edits the same step JSON as the list editor (docs/workflow-actions.md
 * → The canvas). Hand-rolled HTML nodes over SVG connectors on a dotted grid – drag to pan, wheel or pinch to zoom, keys to move
 * between steps; node offsets and sticky notes live in settings.layout. Clicking a node opens the step's own form in a drawer.
 * A lazy chunk: the workflow page loads it when someone switches to the canvas.
 */

type Trigger = { type?: string; config?: Record<string, any> } | null | undefined;
export interface WorkflowCanvasProps {
  workflowId: string;
  steps: Step[];
  trigger: Trigger;
  layout?: WorkflowLayout;
  cat?: Catalog;
  labels: Record<string, [IconName, string]>;
  info: (type: string) => [IconName, string];
  summary: (s: Step) => string;
  triggerLabel: (type?: string) => string;
  newStep: (type: string) => Step;
  renderStep: (step: Step, set: (patch: any) => void) => ReactNode;
  renderTrigger: (trigger: any, set: (trigger: any) => void) => ReactNode;
  onSteps: (steps: Step[]) => void;
  onLayout: (layout: WorkflowLayout | undefined) => void;
  /** Drawer → Speichern: apply and save the workflow. */
  onCommit: (patch: { steps?: Step[]; trigger?: any }) => unknown;
  issues: Record<string, Issue[]>;
  runs?: { runs: any[]; at: Record<string, number> };
  ops: StepOps;
}

const Z_MIN = 0.2;
const Z_MAX = 2;
const clampZ = (z: number) => Math.min(Z_MAX, Math.max(Z_MIN, z));
const GRID = 20;
/** Icon tile colours per catalogue category. */
const TILE: Record<string, string> = { flow: '#7c3aed', data: '#0891b2', crm: '#059669', sales: '#d97706', messaging: '#2563eb', payments: '#16a34a', content: '#db2777', ai: '#9333ea', integration: '#475569', apps: '#0284c7', apps_composio: '#64748b' };
const STATS_KEY = 'pghl.wf-canvas-stats';
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const typing = (el: EventTarget | null) => el instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);

type Gesture =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { kind: 'node'; key: string; sx: number; sy: number; moved: boolean }
  | { kind: 'note'; id: string; mode: 'move' | 'resize'; sx: number; sy: number; moved: boolean }
  | { kind: 'pinch'; d0: number; z0: number; mx: number; my: number; vx: number; vy: number };

export function WorkflowCanvas(p: WorkflowCanvasProps) {
  const t = useT('wfcanvas');
  const { steps, trigger, ops } = p;
  const offsets = p.layout?.offsets ?? {};
  const notes = p.layout?.notes ?? [];
  const [drag, setDrag] = useState<{ key: string; dx: number; dy: number } | null>(null);
  const [noteDrag, setNoteDrag] = useState<{ id: string; dx: number; dy: number; resize: boolean } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const noteDragRef = useRef(noteDrag);
  noteDragRef.current = noteDrag;
  const live = useMemo(() => {
    if (!drag) return offsets;
    const [ox, oy] = offsets[drag.key] ?? [0, 0];
    return { ...offsets, [drag.key]: [ox + drag.dx, oy + drag.dy] as [number, number] };
  }, [offsets, drag]);
  const lay = useMemo(() => layoutFlow(steps, branchesOf, live, { trigger: !!trigger?.type }), [steps, live, trigger?.type]);
  const shownNotes = useMemo(
    () => notes.map((n) => (noteDrag?.id === n.id ? (noteDrag.resize ? { ...n, w: Math.max(140, n.w + noteDrag.dx), h: Math.max(80, n.h + noteDrag.dy) } : { ...n, x: n.x + noteDrag.dx, y: n.y + noteDrag.dy }) : n)),
    [notes, noteDrag],
  );

  const box = useRef<HTMLDivElement>(null);
  const vp = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ x: 0, y: 40, z: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [animate, setAnimate] = useState(false);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ kind: 'step'; id: string } | { kind: 'trigger' } | null>(null);
  const [menu, setMenu] = useState<{ items: MenuItem[]; at: { x: number; y: number }; label: string } | null>(null);
  const [picker, setPicker] = useState<Slot | null>(null);
  const [help, setHelp] = useState(false);
  const [showStats, setShowStats] = useState(() => {
    try {
      return localStorage.getItem(STATS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const stats = useMemo(() => (showStats ? stepStats(p.runs?.runs, p.runs?.at) : {}), [showStats, p.runs]);
  const stepMenu = useStepMenu();
  const issueText = useIssueText();
  const suppressClick = useRef(false);

  // --- view -------------------------------------------------------------------------------------------
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const contentBounds = useCallback(() => {
    let { x, y, w, h } = lay.bounds;
    for (const n of notes) {
      const x1 = Math.max(x + w, n.x + n.w);
      const y1 = Math.max(y + h, n.y + n.h);
      x = Math.min(x, n.x);
      y = Math.min(y, n.y);
      w = x1 - x;
      h = y1 - y;
    }
    return { x, y, w, h };
  }, [lay.bounds, notes]);

  const go = useCallback((next: View, smooth = false) => {
    if (smooth && !reducedMotion()) {
      setAnimate(true);
      window.setTimeout(() => setAnimate(false), 220);
    }
    setView(next);
  }, []);

  const fit = useCallback(
    (smooth = true) => {
      if (!size.w || !size.h) return;
      const b = contentBounds();
      const pad = 56;
      const z = clampZ(Math.min(1, (size.w - pad * 2) / Math.max(1, b.w), (size.h - pad * 2) / Math.max(1, b.h)));
      const x = size.w / 2 - (b.x + b.w / 2) * z;
      const y = b.h * z + pad * 2 <= size.h ? size.h / 2 - (b.y + b.h / 2) * z : pad - b.y * z;
      go({ x, y, z }, smooth);
    },
    [size.w, size.h, contentBounds, go],
  );
  // The canvas fills the window below the page header (at least 480 px).
  const [height, setHeight] = useState<number | undefined>();
  useLayoutEffect(() => {
    const measure = () => {
      const el = box.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      setHeight(Math.max(480, window.innerHeight - top - 16));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  /** First view: everything when it is readable that way, otherwise the top of the flow at a readable size. */
  const fitted = useRef(false);
  useEffect(() => {
    // wait until the measured height is in place (the size comes from a ResizeObserver)
    if (fitted.current || !size.w || height === undefined || Math.abs(size.h + 2 - height) > 4) return;
    fitted.current = true;
    const b = contentBounds();
    const pad = 56;
    const zw = (size.w - pad * 2) / Math.max(1, b.w);
    const zh = (size.h - pad * 2) / Math.max(1, b.h);
    if (Math.min(zw, zh) >= 0.75) return fit(false);
    const z = Math.max(0.6, Math.min(1, zw));
    const trig = lay.nodes.find((n) => n.key === 'trigger');
    const cx = b.w * z <= size.w - pad * 2 ? b.x + b.w / 2 : trig ? trig.x + trig.w / 2 : 0;
    go({ z, x: size.w / 2 - cx * z, y: pad + 24 - b.y * z });
  }, [size.w, size.h, height, fit, contentBounds, lay.nodes, go]);

  const zoomAt = useCallback((mx: number, my: number, factor: number, smooth = false) => {
    const v = viewRef.current;
    const z = clampZ(v.z * factor);
    go({ z, x: mx - ((mx - v.x) * z) / v.z, y: my - ((my - v.y) * z) / v.z }, smooth);
  }, [go]);
  const zoomBy = (factor: number) => zoomAt(size.w / 2, size.h / 2, factor, true);
  const panBy = (dx: number, dy: number) => go({ ...viewRef.current, x: viewRef.current.x + dx, y: viewRef.current.y + dy });

  /** Pans just enough to show a node with some room around it. */
  const reveal = useCallback(
    (n: LNode) => {
      const v = viewRef.current;
      const m = 48;
      const sx = n.x * v.z + v.x;
      const sy = n.y * v.z + v.y;
      let dx = 0;
      let dy = 0;
      if (sx < m) dx = m - sx;
      else if (sx + n.w * v.z > size.w - m) dx = size.w - m - (sx + n.w * v.z);
      if (sy < m) dy = m - sy;
      else if (sy + n.h * v.z > size.h - m) dy = size.h - m - (sy + n.h * v.z);
      if (dx || dy) go({ ...v, x: v.x + dx, y: v.y + dy }, true);
    },
    [size.w, size.h, go],
  );

  // Wheel and trackpad pinch zoom around the pointer (a non-passive listener, so the page does not scroll).
  useEffect(() => {
    const el = vp.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest?.('textarea')) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // --- pointer gestures: pan, drag a node or a note, pinch -------------------------------------------------
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const local = (e: { clientX: number; clientY: number }) => {
    const r = vp.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = e.target as HTMLElement;
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const v = viewRef.current;
      gesture.current = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: v.z, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, vx: v.x, vy: v.y };
      setDrag(null);
      setNoteDrag(null);
      return;
    }
    if (target.closest('.wfc-nodrag')) return;
    const node = target.closest<HTMLElement>('[data-node]');
    const note = target.closest<HTMLElement>('[data-note]');
    if (node?.dataset.node && node.dataset.node !== 'end') gesture.current = { kind: 'node', key: node.dataset.node, sx: e.clientX, sy: e.clientY, moved: false };
    else if (note?.dataset.note && (target.closest('.wfc-note-bar') || target.closest('.wfc-note-resize'))) gesture.current = { kind: 'note', id: note.dataset.note, mode: target.closest('.wfc-note-resize') ? 'resize' : 'move', sx: e.clientX, sy: e.clientY, moved: false };
    else if (!note) {
      const v = viewRef.current;
      gesture.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y };
      vp.current?.classList.add('panning');
    }
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, local(e));
      const g = gesture.current;
      if (!g) return;
      const z = viewRef.current.z;
      if (g.kind === 'pinch') {
        const pts = [...pointers.current.values()];
        if (pts.length < 2) return;
        const [a, b] = pts;
        const nz = clampZ((g.z0 * Math.hypot(a.x - b.x, a.y - b.y)) / g.d0);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        setView({ z: nz, x: mx - ((g.mx - g.vx) * nz) / g.z0, y: my - ((g.my - g.vy) * nz) / g.z0 });
      } else if (g.kind === 'pan') {
        setView((v) => ({ ...v, x: g.vx + e.clientX - g.sx, y: g.vy + e.clientY - g.sy }));
      } else {
        const dx = e.clientX - g.sx;
        const dy = e.clientY - g.sy;
        if (!g.moved && Math.hypot(dx, dy) < 5) return;
        g.moved = true;
        if (g.kind === 'node') setDrag({ key: g.key, dx: dx / z, dy: dy / z });
        else setNoteDrag({ id: g.id, dx: dx / z, dy: dy / z, resize: g.mode === 'resize' });
      }
    };
    const up = (e: PointerEvent) => {
      pointers.current.delete(e.pointerId);
      const g = gesture.current;
      vp.current?.classList.remove('panning');
      if (!g) return;
      if (g.kind === 'pinch') {
        if (pointers.current.size < 2) gesture.current = null;
        return;
      }
      gesture.current = null;
      if (g.kind === 'node' && g.moved) {
        // the click that follows the drop must not open the node; cleared after that click had its chance
        suppressClick.current = true;
        window.setTimeout(() => (suppressClick.current = false), 0);
        const d = dragRef.current;
        setDrag(null);
        if (d) {
          const [ox, oy] = offsets[d.key] ?? [0, 0];
          p.onLayout({ v: 1, ...p.layout, offsets: { ...offsets, [d.key]: [Math.round(ox + d.dx), Math.round(oy + d.dy)] } });
        }
      } else if (g.kind === 'note' && g.moved) {
        const d = noteDragRef.current;
        setNoteDrag(null);
        if (d) setNotes(notes.map((n) => (n.id !== d.id ? n : d.resize ? { ...n, w: Math.round(Math.max(140, n.w + d.dx)), h: Math.round(Math.max(80, n.h + d.dy)) } : { ...n, x: Math.round(n.x + d.dx), y: Math.round(n.y + d.dy) })));
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  });

  // --- notes ------------------------------------------------------------------------------------------
  const setNotes = (next: CanvasNote[]) => {
    const keep = Object.keys(offsets).length ? { offsets } : {};
    p.onLayout(next.length || Object.keys(keep).length ? { v: 1, ...keep, ...(next.length ? { notes: next } : {}) } : undefined);
  };
  const addNote = (at?: { x: number; y: number }) => {
    const v = viewRef.current;
    const c = at ?? { x: (size.w / 2 - v.x) / v.z - 110, y: (size.h / 2 - v.y) / v.z - 70 };
    const id = `n${newId()}`;
    setNotes([...notes, { id, x: Math.round(c.x), y: Math.round(c.y), w: 220, h: 140, text: '', color: 'yellow' }]);
    requestAnimationFrame(() => box.current?.querySelector<HTMLTextAreaElement>(`[data-note="${id}"] textarea`)?.focus({ preventScroll: true }));
  };
  const patchNote = (id: string, patch: Partial<CanvasNote>) => setNotes(notes.map((n) => (n.id === id ? { ...n, ...patch } : n)));
  /** Back to the automatic layout: every node offset goes, the notes stay. */
  const tidy = () => p.onLayout(notes.length ? { v: 1, notes } : undefined);

  // --- actions ------------------------------------------------------------------------------------------
  const nodeByKey = useMemo(() => new Map(lay.nodes.map((n) => [n.key, n])), [lay.nodes]);
  const stepOf = (key: string): Step | undefined => nodeByKey.get(key)?.step ?? (nodeByKey.get(key)?.lane ? findStep(steps, nodeByKey.get(key)!.lane!.parent) : undefined);
  const openNode = (key: string) => {
    if (key === 'trigger') return setDrawer({ kind: 'trigger' });
    const s = stepOf(key);
    if (s) setDrawer({ kind: 'step', id: s.id });
  };
  const focusNode = (key: string) => {
    const n = nodeByKey.get(key);
    if (!n) return;
    setFocusKey(key);
    reveal(n);
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true }));
  };
  const menuFor = (key: string, at: { x: number; y: number }) => {
    const s = nodeByKey.get(key)?.step;
    if (!s) return key === 'trigger' ? setMenu({ at, label: t('Auslöser'), items: [{ key: 'edit', label: t('Bearbeiten'), icon: 'edit', onSelect: () => openNode('trigger') }] }) : undefined;
    setMenu({ at, label: t('Aktionen des Schritts'), items: stepMenu(ops, s, [{ key: 'edit', label: t('Bearbeiten'), icon: 'edit', hint: '↵', onSelect: () => openNode(key) }]) });
  };
  const onPlus = (slot: Slot, e: React.MouseEvent) => {
    e.stopPropagation();
    if (ops.moving) return ops.moveTo(slot);
    if (!ops.clip) return setPicker(slot);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      at: { x: r.right + 6, y: r.top },
      label: t('Hier einfügen'),
      items: [
        { key: 'add', label: t('Aktion hinzufügen …'), icon: 'plus', onSelect: () => setPicker(slot) },
        { key: 'paste', label: t.plural(countSteps(ops.clip.steps), { one: 'Kopierten Schritt einfügen', other: '{n} kopierte Schritte einfügen' }), icon: 'copy', onSelect: () => void ops.paste(slot) },
      ],
    });
  };
  const insertStep = (slot: Slot, type: string) => {
    const s = p.newStep(type);
    const at = (list: Step[]): Step[] => [...list.slice(0, slot.index), s, ...list.slice(slot.index)];
    p.onSteps(slot.parent === null ? at(steps) : updateStep(steps, slot.parent, (c) => ({ ...c, [slot.key]: at(Array.isArray(c[slot.key]) ? c[slot.key] : []) })));
    setDrawer({ kind: 'step', id: s.id });
    setFocusKey(s.id);
  };

  // --- keyboard -------------------------------------------------------------------------------------------
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (typing(e.target) || (e.target as HTMLElement).closest('.wfc-drawer, .wfc-menu, .modal')) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const node = focusKey ? nodeByKey.get(focusKey) : undefined;
    const step = node?.step;
    const dirs: Record<string, 'up' | 'down' | 'left' | 'right'> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    const k = e.key;
    if (dirs[k]) {
      if (node && !e.shiftKey) {
        // ↑/↓ walk the flow in reading order (into lanes and out again), ←/→ jump to the nearest node at the side
        const order = lay.nodes.filter((n) => n.kind !== 'end');
        const next = k === 'ArrowDown' || k === 'ArrowUp' ? order[order.indexOf(node) + (k === 'ArrowDown' ? 1 : -1)] : nearestNode(lay.nodes, node, dirs[k]);
        if (next) focusNode(next.key);
      } else {
        const d = 80;
        panBy(k === 'ArrowLeft' ? d : k === 'ArrowRight' ? -d : 0, k === 'ArrowUp' ? d : k === 'ArrowDown' ? -d : 0);
      }
    } else if (!mod && (k === '+' || k === '=')) zoomBy(1.2);
    else if (!mod && (k === '-' || k === '_')) zoomBy(1 / 1.2);
    else if (!mod && k === '0') go({ ...viewRef.current, z: 1 }, true);
    else if (!mod && (k === 'f' || k === 'F')) fit();
    else if (!mod && (k === 'n' || k === 'N')) addNote();
    else if (!mod && k === '?') setHelp(true);
    else if (step && (k === 'Delete' || k === 'Backspace')) ops.remove(step.id);
    else if (step && !mod && (k === 'p' || k === 'P')) ops.toggle(step.id);
    else if (step && mod && (k === 'c' || k === 'C')) void ops.copy(step.id);
    else if (step && mod && (k === 'd' || k === 'D')) ops.duplicate(step.id);
    else if (mod && (k === 'v' || k === 'V') && ops.clip) void ops.paste(slotAfter(steps, step?.id));
    else if (node && (k === 'ContextMenu' || (e.shiftKey && k === 'F10'))) {
      const r = box.current!.querySelector<HTMLElement>(`[data-key="${CSS.escape(node.key)}"]`)?.getBoundingClientRect();
      menuFor(node.key, { x: r ? r.right - 40 : 100, y: r ? r.bottom : 100 });
    } else return;
    e.preventDefault();
  };

  // --- render ----------------------------------------------------------------------------------------------
  const worldStyle: CSSProperties = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` };
  const gridStyle: CSSProperties = { backgroundSize: `${GRID * view.z}px ${GRID * view.z}px`, backgroundPosition: `${view.x}px ${view.y}px` };
  const categoryOf = (type: string) => p.cat?.actions.find((a) => a.type === type)?.category ?? 'flow';
  const filters = Object.values(trigger?.config ?? {}).filter((v) => (Array.isArray(v) ? v.length : !!v)).length;

  const renderNode = (n: LNode) => {
    const common = { 'data-node': n.key, style: { left: n.x, top: n.y, width: n.w, height: n.h } as CSSProperties };
    const onCard = (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('.wfc-nodrag')) return;
      if (suppressClick.current) return void (suppressClick.current = false);
      setFocusKey(n.key);
      openNode(n.key);
    };
    const ctx = (e: React.MouseEvent) => (e.preventDefault(), setFocusKey(n.key), menuFor(n.key, { x: e.clientX, y: e.clientY }));
    if (n.kind === 'end') {
      return (
        <div key={n.key} className="wfc-end" {...common} data-node="end">
          {t('Ende')}
        </div>
      );
    }
    if (n.kind === 'add-trigger') {
      return (
        <div key={n.key} className="wfc-node wfc-add-trigger" {...common} onClick={onCard}>
          <button type="button" className="wfc-main" data-key="trigger" onFocus={() => setFocusKey('trigger')}>
            <Icon name="plus" /> {t('Auslöser hinzufügen')}
          </button>
        </div>
      );
    }
    if (n.kind === 'trigger') {
      return (
        <div key={n.key} className={`wfc-node wfc-trigger${focusKey === n.key ? ' on' : ''}`} {...common} onClick={onCard} onContextMenu={ctx}>
          <span className="wfc-tile" style={{ '--tile': '#f59e0b' } as CSSProperties}>
            <Icon name="trigger" size={18} />
          </span>
          <button type="button" className="wfc-main" data-key="trigger" onFocus={() => setFocusKey('trigger')} aria-label={`${t('Auslöser')}: ${p.triggerLabel(trigger?.type)}`}>
            <span className="wfc-eyebrow">{t('Auslöser')}</span>
            <span className="wfc-title">{p.triggerLabel(trigger?.type)}</span>
            <span className="wfc-sub">{filters ? t('mit Einstellungen / Filtern') : t('ohne Filter')}</span>
          </button>
        </div>
      );
    }
    if (n.kind === 'branch') {
      const l = n.lane!;
      return (
        <div key={n.key} className={`wfc-node wfc-branch${l.tone ? ` tone-${l.tone}` : ''}${focusKey === n.key ? ' on' : ''}`} {...common} onClick={onCard}>
          <button type="button" className="wfc-main" data-key={n.key} onFocus={() => setFocusKey(n.key)}>
            {l.tone === 'yes' ? <Icon name="ok" size={14} /> : l.tone === 'no' ? <Icon name="fail" size={14} /> : <Icon name="branch" size={14} />} <span>{l.label}</span>
          </button>
        </div>
      );
    }
    const s = n.step!;
    const [icon, label] = p.info(s.type);
    const bad = p.issues[s.id];
    const st = stats[s.id];
    const sub = s.name ? s.name : p.summary(s) || t('Noch nicht eingerichtet');
    return (
      <div
        key={n.key}
        className={`wfc-node wfc-step${focusKey === n.key ? ' on' : ''}${s.disabled ? ' paused' : ''}${bad ? ' bad' : ''}${ops.moving === s.id ? ' moving' : ''}`}
        {...common}
        onClick={onCard}
        onContextMenu={ctx}
      >
        <span className="wfc-tile" style={{ '--tile': TILE[categoryOf(s.type)] ?? '#64748b' } as CSSProperties}>
          <Icon name={icon} size={18} />
        </span>
        <button type="button" className="wfc-main" data-key={n.key} onFocus={() => setFocusKey(n.key)} aria-label={`${label}${s.name ? ` – ${s.name}` : ''}${s.disabled ? ` (${t('pausiert')})` : ''}${bad ? ` – ${t.plural(bad.length, { one: 'eine Angabe fehlt', other: '{n} Angaben fehlen' })}` : ''}`}>
          <span className="wfc-title">{label}</span>
          <span className="wfc-sub">{sub}</span>
        </button>
        <span className="wfc-node-tools wfc-nodrag">
          <PauseSwitch paused={!!s.disabled} onToggle={() => ops.toggle(s.id)} />
          <button
            type="button"
            className="icon-btn wfc-kebab"
            aria-label={t('Weitere Aktionen')}
            aria-haspopup="menu"
            onClick={(e) => {
              e.stopPropagation();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setFocusKey(n.key);
              menuFor(n.key, { x: r.left, y: r.bottom + 4 });
            }}
          >
            ⋮
          </button>
        </span>
        {s.disabled && <span className="wfc-tag paused">{t('Pausiert')}</span>}
        {bad && (
          <span className="wfc-tag bad" title={bad.map(issueText).join('\n')}>
            ! {bad.length}
          </span>
        )}
        {st && (st.done || st.errors || st.skipped || st.waiting) ? (
          <span className="wfc-stats" title={t('Aus den letzten Läufen: durchgelaufen, Fehler, übersprungen, wartet gerade hier')}>
            <span className="ok">✓ {st.done}</span>
            {st.errors ? <span className="err">⚠ {st.errors}</span> : null}
            {st.skipped ? <span>↷ {st.skipped}</span> : null}
            {st.waiting ? <span className="wait">⏳ {st.waiting}</span> : null}
          </span>
        ) : showStats ? (
          <span className="wfc-stats empty">0</span>
        ) : null}
      </div>
    );
  };

  const draftStep = drawer?.kind === 'step' ? findStep(steps, drawer.id) : undefined;

  return (
    <div ref={box} className={`wfc${ops.moving ? ' is-moving' : ''}`} style={height ? { height } : undefined} onKeyDown={onKeyDown} data-tour="wf-canvas">
      <div
        ref={vp}
        className="wfc-vp"
        style={gridStyle}
        tabIndex={0}
        role="application"
        aria-roledescription={t('Workflow-Canvas')}
        aria-label={t('Workflow-Canvas: Pfeiltasten wechseln zwischen den Schritten, Enter öffnet einen Schritt, + und − zoomen, F passt ein, ? zeigt alle Tasten.')}
        onPointerDown={onPointerDown}
        onScroll={(e) => {
          // The browser scrolls this box to show a focused node (Tab) – turn that into a pan of the view instead.
          const el = e.currentTarget;
          if (!el.scrollLeft && !el.scrollTop) return;
          panBy(-el.scrollLeft, -el.scrollTop);
          el.scrollLeft = 0;
          el.scrollTop = 0;
        }}
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest('[data-node], [data-note]')) return;
          e.preventDefault();
          const v = viewRef.current;
          const pt = local(e);
          const world = { x: (pt.x - v.x) / v.z, y: (pt.y - v.y) / v.z };
          setMenu({
            at: { x: e.clientX, y: e.clientY },
            label: t('Canvas'),
            items: [
              { key: 'note', label: t('Notiz hier anlegen'), icon: 'note', hint: 'N', onSelect: () => addNote(world) },
              ...(ops.clip ? [{ key: 'paste', label: t('Am Ende einfügen'), icon: 'copy' as IconName, onSelect: () => void ops.paste(slotAfter(steps, null)) }] : []),
              { key: 'fit', label: t('Einpassen'), icon: 'grid', hint: 'F', onSelect: () => fit() },
            ],
          });
        }}
      >
        <div className={`wfc-world${animate ? ' anim' : ''}`} style={worldStyle}>
          <svg className="wfc-edges" width="1" height="1" aria-hidden="true">
            {lay.edges.map((e) => (
              <path key={e.key} d={e.d} className={`${e.tone ? `tone-${e.tone}` : ''}${e.loop ? ' loop' : ''}`} />
            ))}
            {lay.joins.map((j) => (
              <circle key={j.key} cx={j.x} cy={j.y} r={4} />
            ))}
          </svg>
          {shownNotes.map((n) => (
            <Note key={n.id} note={n} onChange={(patch) => patchNote(n.id, patch)} onRemove={() => setNotes(notes.filter((x) => x.id !== n.id))} />
          ))}
          {lay.nodes.map(renderNode)}
          {lay.inserts.map((i) =>
            ops.moving ? (
              ops.canMoveTo(i.slot) && (
                <button key={i.key} type="button" className="wfc-plus drop wfc-nodrag" style={{ left: i.x, top: i.y }} aria-label={t('Hierher verschieben')} title={t('Hierher verschieben')} onClick={(e) => onPlus(i.slot, e)}>
                  <Icon name="move" size={14} />
                </button>
              )
            ) : (
              <button key={i.key} type="button" className="wfc-plus wfc-nodrag" style={{ left: i.x, top: i.y }} aria-label={t('Schritt hier einfügen')} title={t('Schritt hier einfügen')} onClick={(e) => onPlus(i.slot, e)}>
                +
              </button>
            ),
          )}
        </div>
      </div>

      {ops.moving && (
        <div className="wfc-move wfc-ui" role="status">
          <Icon name="move" size={15} /> {t('Verschieben: auf einen blauen Punkt klicken – Esc bricht ab.')}
          <button type="button" className="btn small secondary" onClick={ops.cancelMove}>
            {t('Abbrechen')}
          </button>
        </div>
      )}
      <div className="wfc-toolbar wfc-ui" role="toolbar" aria-label={t('Werkzeuge des Canvas')}>
        <button type="button" className="btn small secondary" onClick={() => addNote()} title={t('Notiz anlegen (N)')}>
          <Icon name="note" size={14} /> {t('Notiz')}
        </button>
        <button
          type="button"
          className={`btn small ${showStats ? '' : 'secondary'}`}
          aria-pressed={showStats}
          onClick={() => {
            setShowStats(!showStats);
            try {
              localStorage.setItem(STATS_KEY, showStats ? '0' : '1');
            } catch {
              /* only for this visit */
            }
          }}
        >
          <Icon name="reports" size={14} /> {t('Statistik')}
        </button>
        <button type="button" className="btn small secondary" onClick={tidy} disabled={!Object.keys(offsets).length} title={t('Alle Schritte wieder automatisch anordnen (Notizen bleiben)')}>
          <Icon name="grid" size={14} /> {t('Anordnen')}
        </button>
        <button type="button" className="btn small ghost" onClick={() => setHelp(true)} aria-label={t('Tastenkürzel')} title={t('Tastenkürzel (?)')}>
          ⌨
        </button>
        {showStats && <span className="wfc-hint">{t.plural(p.runs?.runs?.length ?? 0, { one: 'Zahlen aus dem letzten Lauf', other: 'Zahlen aus den letzten {n} Läufen' })}</span>}
      </div>

      <div className="wfc-corner wfc-ui">
        <div className="wfc-zoom" role="group" aria-label={t('Zoom')}>
          <button type="button" onClick={() => zoomBy(1.2)} aria-label={t('Vergrößern')} title={t('Vergrößern (+)')}>
            +
          </button>
          <button type="button" className="pct" onClick={() => go({ ...view, z: 1 }, true)} aria-label={t('Auf 100 % zurücksetzen')} title={t('Auf 100 % zurücksetzen (0)')}>
            {Math.round(view.z * 100)} %
          </button>
          <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label={t('Verkleinern')} title={t('Verkleinern (−)')}>
            −
          </button>
          <button type="button" onClick={() => fit()} aria-label={t('Einpassen')} title={t('Einpassen (F)')}>
            ⤢
          </button>
        </div>
        <Minimap nodes={lay.nodes} notes={notes} bounds={contentBounds()} view={view} size={size} onCenter={(x, y) => go({ ...viewRef.current, x: size.w / 2 - x * viewRef.current.z, y: size.h / 2 - y * viewRef.current.z })} />
      </div>

      {drawer?.kind === 'step' && draftStep && (
        <StepDrawer
          key={draftStep.id}
          step={draftStep}
          steps={steps}
          cat={p.cat}
          info={p.info}
          renderStep={p.renderStep}
          onClose={() => setDrawer(null)}
          onSave={async (next) => {
            setDrawer(null);
            await p.onCommit({ steps: updateStep(steps, next.id, () => next) });
          }}
        />
      )}
      {drawer?.kind === 'trigger' && (
        <TriggerDrawer
          trigger={trigger?.type ? trigger : { type: 'contact.tag_added', config: {} }}
          renderTrigger={p.renderTrigger}
          onClose={() => setDrawer(null)}
          onSave={async (next) => {
            setDrawer(null);
            await p.onCommit({ trigger: next });
          }}
        />
      )}
      {menu && <PopMenu items={menu.items} at={menu.at} label={menu.label} onClose={() => setMenu(null)} />}
      {picker && <ActionPicker builtin={p.labels} onPick={(type) => insertStep(picker, type)} onClose={() => setPicker(null)} />}
      {help && <KeysHelp onClose={() => setHelp(false)} />}
    </div>
  );
}
