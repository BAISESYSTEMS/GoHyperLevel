import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { api } from '../api';
import { act, navigate, toast, toastError } from '../ui';
import { useSession } from '../session';
import { Icon } from '../icons';
import { type CanvasElement, type FontKey, FRAME_PRESETS, STICKY_COLORS, createElement, defaultsFor, elementBox, fitToPoints } from '../../../server/services/canvas-model';
import { type CardData, type RenderCtx, type RenderNode, cardKey, elementSvg, lineGeometry, renderTree } from '../../../server/services/canvas-render';
import { layoutText, FONT_STACK, LINE_HEIGHT } from '../../../server/services/canvas-text';
import { type Pt } from '../../../server/services/canvas-path';
import { BoardStore, newId, type Comment } from './store';
import { type Guide, type Handle, type View, HANDLES, bindTarget, boxOf, frameAt, handlePos, hitTest, inLasso, inRect, localPoint, resizeBox, round, scaleElement, selectionBox, snapBox, toScreen, toWorld } from './geometry';
import { align, distribute, duplicate, expandSelection, group, groupMembers, parseClipboard, pasteAt, reorder, serialize, sizedText, ungroup, withDependents } from './actions';
import { Inspector, LayersPanel, Minimap, Toolbar, type Tool } from './panels';
import { CommentsPanel, CommentPins } from './comments';
import { AiBar } from './ai';
import { Dialogs, type DialogKind } from './dialogs';
import { imageElement, uploadImage } from './media';
import { XrButton } from '../xr/XrButton';
// Live-Zusammenarbeit: "Mauszeiger anderer zeigen" and following a person (docs/collaboration.md).
import { CanvasPeople } from '../presence/canvas';
import { usePresence } from '../presence/store';

/**
 * The Canvas editor: an infinite board drawn as SVG (each element rendered by the shared renderer),
 * with tools, selection, transforms, smart guides, text editing, clipboard, realtime presence and
 * the panels around it. Works with mouse, pen and touch (pinch to zoom, two fingers to pan).
 */

export interface BoardMeta {
  id: string;
  name: string;
  description: string;
  team_access: 'edit' | 'view' | 'none';
  owner_id: string | null;
  owner_name: string;
  settings: { grid?: 'dots' | 'lines' | 'none'; snap?: boolean; sketch?: boolean; background?: string | null };
  access: 'owner' | 'edit' | 'view';
}

export interface EditorApi {
  store: BoardStore;
  board: BoardMeta;
  readOnly: boolean;
  selection: string[];
  select: (ids: string[]) => void;
  selected: CanvasElement[];
  view: View;
  setView: (v: View | ((v: View) => View)) => void;
  size: { w: number; h: number };
  tool: Tool;
  setTool: (t: Tool) => void;
  dark: boolean;
  /** Centre of the visible area in board coordinates. */
  center: () => Pt;
  zoomTo: (ids?: string[]) => void;
  insert: (els: CanvasElement[], opts?: { at?: Pt; select?: boolean }) => string[];
  patch: (ids: string[], p: Partial<CanvasElement>) => void;
  open: (d: DialogKind, data?: any) => void;
  refreshCards: () => Promise<void>;
  saveBoard: (p: Partial<BoardMeta>) => Promise<void>;
  editText: (id: string) => void;
  catchUpCreated: () => Promise<void>;
  comments: { open: boolean; toggle: () => void; focus: (c: Comment) => void };
  defaults: Partial<CanvasElement>;
  setDefaults: (p: Partial<CanvasElement>) => void;
}

type Drag =
  | { kind: 'pan'; sx: number; sy: number; tx: number; ty: number }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; add: boolean }
  | { kind: 'lasso'; pts: Pt[]; add: boolean }
  | { kind: 'move'; start: Pt; orig: Map<string, CanvasElement>; ids: string[]; moved: boolean; box: CanvasElement[] }
  | { kind: 'resize'; handle: Handle; orig: Map<string, CanvasElement>; box: { x: number; y: number; w: number; h: number }; single: CanvasElement | null }
  | { kind: 'rotate'; id: string; orig: CanvasElement; center: Pt }
  | { kind: 'create'; id: string; start: Pt; type: string }
  | { kind: 'line'; id: string; start: Pt }
  | { kind: 'point'; id: string; index: number; orig: CanvasElement; insert: boolean }
  | { kind: 'draw'; id: string; pts: number[][]; t: number; last: Pt };

const SHAPE_TOOLS = new Set(['rect', 'ellipse', 'diamond', 'frame']);
/** While one of these is active the style panel shows the defaults for new elements. */
const CREATE_TOOLS = new Set<string>(['rect', 'ellipse', 'diamond', 'line', 'arrow', 'draw', 'text', 'sticky']);
const TOL = 6;
const isLine = (e?: CanvasElement | null) => !!e && (e.type === 'line' || e.type === 'arrow');
const prefersDark = () => {
  const t = document.documentElement.getAttribute('data-theme');
  if (t) return t === 'dark';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
};

/** One element, re-rendered only when it (or what it depends on) changes. */
const ElementView = memo(
  function ElementView({ el, ctx, dark }: { el: CanvasElement; ctx: RenderCtx; dark: boolean; deps: unknown[] }) {
    return <g data-id={el.id} dangerouslySetInnerHTML={{ __html: elementSvg(el, ctx, { dark }) }} />;
  },
  (a, b) => a.el === b.el && a.dark === b.dark && a.deps.length === b.deps.length && a.deps.every((d, i) => d === b.deps[i]),
);

/**
 * The drawn board. Memoized on what it draws (elements, card data, theme, the visible region in coarse
 * steps), so panning and zooming only move the surrounding transform instead of re-rendering thousands of elements.
 */
const Scene = memo(function Scene({ tree, byId, cards, editingId, dark, rev, x1, y1, x2, y2 }: { tree: RenderNode[]; byId: Map<string, CanvasElement>; cards: Record<string, CardData>; editingId?: string; dark: boolean; rev: number; x1: number; y1: number; x2: number; y2: number }) {
  void rev;
  // colours are made in light space and darkened afterwards, so the label background is always white here
  const ctx: RenderCtx = { byId, cards, editing: editingId, labelBg: '#ffffff' };
  const inView = (el: CanvasElement) => {
    if (isLine(el)) return true;
    const b = elementBox(el);
    return b.x < x2 && b.x + b.w > x1 && b.y - 30 < y2 && b.y + b.h > y1;
  };
  const depsOf = (el: CanvasElement): unknown[] => {
    const d: unknown[] = [editingId === el.id];
    if (isLine(el)) d.push(el.start ? byId.get(el.start.id) : null, el.end ? byId.get(el.end.id) : null);
    if (el.type === 'card' && el.card) d.push(cards[cardKey(el.card.kind, el.card.id)]);
    return d;
  };
  const nodes: ReactNode[] = [];
  for (const n of tree) {
    if (!inView(n.el) && !(n.children ?? []).some(inView)) continue;
    nodes.push(<ElementView key={n.el.id} el={n.el} ctx={ctx} dark={dark} deps={depsOf(n.el)} />);
    if (n.children?.length)
      nodes.push(
        <g key={`${n.el.id}:kids`} clipPath={`url(#fc-${n.el.id})`}>
          {n.children.filter(inView).map((c) => (
            <ElementView key={c.id} el={c} ctx={ctx} dark={dark} deps={depsOf(c)} />
          ))}
        </g>,
      );
  }
  return <>{nodes}</>;
});

export function Editor({ store, board: initial, onBack }: { store: BoardStore; board: BoardMeta; onBack: () => void }) {
  const session = useSession();
  const rev = useSyncExternalStore(store.subscribe, store.getRev);
  const [board, setBoard] = useState(initial);
  const readOnly = board.access === 'view';
  const [view, setView] = useState<View>({ tx: 0, ty: 0, z: 1 });
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [tool, setToolState] = useState<Tool>('select');
  const [selection, setSelection] = useState<string[]>([]);
  const [drag, setDrag] = useState<Drag | null>(null);
  // cursors off (Team ist hier → Mauszeiger anderer zeigen: Aus): none are shown and mine are not sent
  const cursorsOff = usePresence().prefs.cursors === 'off';
  const [following, setFollowing] = useState<string | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [hoverBind, setHoverBind] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string; isNew: boolean } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; world: Pt } | null>(null);
  const [dialog, setDialog] = useState<{ kind: DialogKind; data?: any } | null>(null);
  const [panels, setPanels] = useState({ layers: false, comments: false, minimap: window.innerWidth > 700 });
  const [dark, setDark] = useState(prefersDark);
  const [space, setSpace] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [defaults, setDefaultsState] = useState<Partial<CanvasElement>>({ sketch: !!initial.settings.sketch });
  const [stickyColor] = useState(STICKY_COLORS.gelb);
  const [commentAt, setCommentAt] = useState<{ x: number; y: number; elementId: string | null } | null>(null);
  const [focusComment, setFocusComment] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  // Focused the moment it appears (same event as the click that created it): typing can start at once.
  const textRef = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; cx: number; cy: number; view: View } | null>(null);
  const lastWorld = useRef<Pt>([0, 0]);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const selRef = useRef(selection);
  selRef.current = selection;

  void rev;
  const byId = store.els;
  const ordered = store.ordered;
  const selected = useMemo(() => selection.map((id) => byId.get(id)).filter((e): e is CanvasElement => !!e), [selection, rev]); // eslint-disable-line react-hooks/exhaustive-deps

  // drop selected ids that disappeared (remote delete, undo)
  useEffect(() => {
    if (selection.some((id) => !byId.has(id))) setSelection((s) => s.filter((id) => byId.has(id)));
  }, [rev]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => store.presence({ sel: selection }), [selection, store]);
  useEffect(() => {
    if (cursorsOff) store.presence({ x: undefined, y: undefined });
  }, [cursorsOff, store]);
  // following somebody: the view stays centred on their cursor (they left → stop)
  useEffect(() => {
    if (!following) return;
    const v = store.viewers.get(following);
    if (!v) return setFollowing(null);
    if (v.x !== undefined && v.y !== undefined) setView((cur) => ({ ...cur, tx: size.w / 2 - v.x! * cur.z, ty: size.h / 2 - v.y! * cur.z }));
  }, [following, rev, size, store]);

  // --- theme & size --------------------------------------------------------------------------------
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const on = () => setDark(prefersDark());
    mq?.addEventListener?.('change', on);
    const obs = new MutationObserver(on);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      mq?.removeEventListener?.('change', on);
      obs.disconnect();
    };
  }, []);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // --- zoom helpers ----------------------------------------------------------------------------------
  const zoomAt = useCallback((factor: number, sx: number, sy: number) => {
    setView((v) => {
      const z = Math.min(8, Math.max(0.05, v.z * factor));
      return { z, tx: sx - ((sx - v.tx) * z) / v.z, ty: sy - ((sy - v.ty) * z) / v.z };
    });
  }, []);
  const zoomTo = useCallback(
    (ids?: string[]) => {
      const els = ids?.length ? ids.map((id) => byId.get(id)!).filter(Boolean) : store.ordered.filter((e) => !e.hidden);
      const b = selectionBox(els, byId);
      const el = wrap.current;
      if (!el) return;
      if (!b) return setView({ tx: el.clientWidth / 2, ty: el.clientHeight / 2, z: 1 });
      // fit into the free part of the stage: not under the toolbar or the bottom bars
      const wide = el.clientWidth > 900;
      const pad = wide ? { l: 60, r: 60, t: 124, b: 150 } : { l: 24, r: 24, t: 70, b: 130 };
      const aw = Math.max(80, el.clientWidth - pad.l - pad.r);
      const ah = Math.max(80, el.clientHeight - pad.t - pad.b);
      const z = Math.min(2, Math.max(0.05, Math.min(aw / Math.max(b.w, 1), ah / Math.max(b.h, 1))));
      setView({ z, tx: pad.l + aw / 2 - (b.x + b.w / 2) * z, ty: pad.t + ah / 2 - (b.y + b.h / 2) * z });
    },
    [byId, store],
  );
  const firstFit = useRef(false);
  useEffect(() => {
    if (firstFit.current || !size.w) return;
    firstFit.current = true;
    const params = new URLSearchParams(location.search);
    const q = params.get('comment');
    if (q) {
      setPanels((p) => ({ ...p, comments: true }));
      setFocusComment(q);
    }
    // ?focus=id,id opens the board zoomed to those elements (links from agents, comments, the funnel dialog …)
    const focus = (params.get('focus') ?? '').split(',').filter((id) => byId.has(id));
    if (focus.length) {
      setSelection(focus);
      zoomTo(focus);
    } else zoomTo();
  }, [size, zoomTo]);

  const center = useCallback((): Pt => toWorld(viewRef.current, size.w / 2, size.h / 2), [size]);

  // --- wheel / gestures ------------------------------------------------------------------------------
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('.cv-panel, .cv-dialog, textarea')) return;
      e.preventDefault();
      setFollowing(null);
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0025)), e.clientX - r.left, e.clientY - r.top);
      else setView((v) => ({ ...v, tx: v.tx - (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX), ty: v.ty - (e.shiftKey && !e.deltaX ? 0 : e.deltaY) }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // --- card data ---------------------------------------------------------------------------------------
  const cardSig = ordered.filter((e) => e.type === 'card' && e.card).map((e) => cardKey(e.card!.kind, e.card!.id)).sort().join(',');
  const refreshCards = useCallback(async () => {
    const refs = [...new Set(cardSig.split(',').filter(Boolean))].map((k) => ({ kind: k.split(':')[0], id: k.split(':').slice(1).join(':') }));
    if (!refs.length) return;
    try {
      const r = await api.post(`/api/canvas/${board.id}/cards`, { refs });
      store.cards = { ...store.cards, ...(r.cards as Record<string, CardData>) };
      store.touch();
    } catch {
      /* cards keep their last state */
    }
  }, [cardSig, board.id, store]);
  useEffect(() => {
    void refreshCards();
    const t = window.setInterval(() => document.visibilityState === 'visible' && void refreshCards(), 60_000);
    return () => window.clearInterval(t);
  }, [refreshCards]);

  // --- store events ------------------------------------------------------------------------------------
  useEffect(() => {
    store.onBoard = (b) => setBoard((cur) => ({ ...cur, ...b, access: cur.access }));
    store.onDeleted = () => {
      toast('Dieses Board wurde gelöscht');
      onBack();
    };
    store.onReload = () => void store.catchUp();
    store.onError = (e) => toastError(e);
    void api
      .get(`/api/canvas/${board.id}/comments`)
      .then((c) => {
        store.comments = c;
        store.touch();
      })
      .catch(() => {});
  }, [store, board.id, onBack]);

  // --- commands ------------------------------------------------------------------------------------------
  const select = useCallback((ids: string[]) => setSelection([...new Set(ids)]), []);
  const setTool = useCallback((t: Tool) => {
    setToolState(t);
    if (t !== 'select' && t !== 'lasso' && t !== 'hand') setSelection([]);
  }, []);
  const insert = useCallback(
    (raw: CanvasElement[], opts: { at?: Pt; select?: boolean } = {}) => {
      if (readOnly || !raw.length) return [];
      const els = raw.map((e) => createElement({ ...e }, newId));
      if (opts.at) {
        const b = selectionBox(els, new Map(els.map((e) => [e.id, e])));
        if (b) {
          const dx = opts.at[0] - (b.x + b.w / 2);
          const dy = opts.at[1] - (b.y + b.h / 2);
          for (const e of els) {
            e.x = round(e.x + dx);
            e.y = round(e.y + dy);
          }
        }
      }
      const top = store.ordered.length ? (store.ordered[store.ordered.length - 1].z ?? 0) : 0;
      const minZ = Math.min(...els.map((e) => e.z ?? 0));
      for (const e of els) e.z = top + 1 + ((e.z ?? 0) - minZ);
      store.add(els);
      const ids = els.filter((e) => !e.frameId || !els.some((x) => x.id === e.frameId)).map((e) => e.id);
      if (opts.select !== false) setSelection(ids);
      return ids;
    },
    [readOnly, store],
  );
  const patch = useCallback((ids: string[], p: Partial<CanvasElement>) => {
    if (readOnly) return;
    const patches: Record<string, Partial<CanvasElement>> = {};
    for (const id of ids) {
      const e = byId.get(id);
      if (!e) continue;
      let next: Partial<CanvasElement> = { ...p };
      if (e.type === 'text' && ('fontSize' in p || 'font' in p || 'bold' in p)) {
        const sized = sizedText({ ...e, ...p } as CanvasElement);
        next = { ...next, h: sized.h };
      }
      patches[id] = next;
    }
    store.update(patches);
  }, [readOnly, store, byId]);
  const saveBoard = useCallback(
    async (p: Partial<BoardMeta>) => {
      const r = await act(() => api.patch(`/api/canvas/${board.id}`, p));
      if (r) setBoard((b) => ({ ...b, ...r, access: b.access }));
    },
    [board.id],
  );
  const catchUpCreated = useCallback(async () => {
    const r = await store.catchUp();
    store.recordCreated(r.created);
    if (r.created.length) setSelection(r.created.filter((e) => !e.frameId || !r.created.some((x) => x.id === e.frameId)).map((e) => e.id));
  }, [store]);

  const deleteSel = useCallback(() => {
    if (readOnly || !selRef.current.length) return;
    store.remove(selRef.current.filter((id) => !byId.get(id)?.locked));
    setSelection([]);
  }, [readOnly, store, byId]);

  const editText = useCallback(
    (id: string) => {
      const e = byId.get(id);
      if (!e || readOnly || e.locked) return;
      if (e.type === 'card') return void (e.card && cardOpen(e));
      if (e.type === 'table') return setDialog({ kind: 'table', data: { id } });
      if (e.type === 'chart') return setDialog({ kind: 'chart', data: { id } });
      if (e.type === 'image' || e.type === 'icon' || e.type === 'draw') return;
      setEditing({ id, value: e.type === 'frame' ? (e.name ?? '') : (e.text ?? ''), isNew: false });
    },
    [byId, readOnly], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const cardOpen = (e: CanvasElement) => {
    const data = store.cards[cardKey(e.card!.kind, e.card!.id)];
    if (data?.url) navigate(data.url);
    else toast(data?.error ?? 'Datensatz wird geladen …');
  };

  const editingRef = useRef(editing);
  editingRef.current = editing;
  const commitText = useCallback(() => {
    // idempotent: Esc and the blur that follows it both end up here
    const ed = editingRef.current;
    if (!ed) return;
    editingRef.current = null;
    setEditing(null);
    const e = byId.get(ed.id);
    if (!e) return;
    if (e.type === 'frame') return void store.update({ [e.id]: { name: ed.value.trim() || 'Rahmen' } });
    if (ed.isNew) {
      // a new text/note was added without history: an empty text is dropped, otherwise creation + text are one undo step
      if (e.type === 'text' && !ed.value.trim()) return void store.remove([e.id], { history: false });
      if (e.type === 'text') {
        const sized = sizedText({ ...e, text: ed.value }, true);
        store.update({ [e.id]: { text: ed.value, w: sized.w, h: sized.h } }, { history: false });
      } else if (ed.value) store.update({ [e.id]: { text: ed.value } }, { history: false });
      const done = store.els.get(e.id);
      if (done) store.recordCreated([done]);
      return;
    }
    if (e.type === 'text') {
      if (!ed.value.trim()) return void store.remove([e.id]);
      const sized = sizedText({ ...e, text: ed.value }, false);
      store.update({ [e.id]: { text: ed.value, w: sized.w, h: sized.h } });
      return;
    }
    if (ed.value !== (e.text ?? '')) store.update({ [e.id]: { text: ed.value || (undefined as any) } });
  }, [byId, store]);

  // --- clipboard -----------------------------------------------------------------------------------------
  const clip = useRef<string>('');
  useEffect(() => {
    const inField = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest('input, textarea, select, [contenteditable="true"]');
    const onCopy = (e: ClipboardEvent) => {
      if (inField(e.target) || !selRef.current.length) return;
      const data = serialize(withDependents(store, selRef.current));
      clip.current = data;
      e.clipboardData?.setData('text/plain', data);
      e.preventDefault();
    };
    const onCut = (e: ClipboardEvent) => {
      if (inField(e.target) || !selRef.current.length || readOnly) return;
      onCopy(e);
      deleteSel();
    };
    const onPaste = async (e: ClipboardEvent) => {
      if (inField(e.target) || readOnly) return;
      const dt = e.clipboardData;
      const file = [...(dt?.items ?? [])].find((i) => i.type.startsWith('image/'))?.getAsFile();
      if (file) {
        e.preventDefault();
        return void addImageFile(file, lastWorld.current);
      }
      const text = dt?.getData('text/plain') ?? '';
      const ours = parseClipboard(text);
      if (ours) {
        e.preventDefault();
        setSelection(pasteAt(store, ours, { x: lastWorld.current[0], y: lastWorld.current[1] }));
        return;
      }
      if (text.trim()) {
        e.preventDefault();
        const t = text.trim().slice(0, 5000);
        const el = /^https?:\/\//.test(t) ? createElement({ type: 'text', x: lastWorld.current[0], y: lastWorld.current[1], text: t, link: t, color: '#1971c2' }, newId) : createElement({ type: 'text', x: lastWorld.current[0], y: lastWorld.current[1], text: t, ...defaultsText() }, newId);
        insert([el]);
      }
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste as any);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste as any);
    };
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const defaultsText = () => ({ font: (defaults.sketch ? 'hand' : 'sans') as FontKey });

  const addImageFile = async (file: File, at: Pt) => {
    try {
      const img = await uploadImage(board.id, file);
      insert([imageElement(img, at[0], at[1])]);
    } catch (e) {
      toastError(e);
    }
  };

  // --- keyboard ---------------------------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"]') || dialog) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (e.key === ' ' && !t.closest('button, a, [role="button"]')) {
        if (!space) setSpace(true);
        e.preventDefault();
        return;
      }
      if (mod && k === 'z') return void (e.preventDefault(), e.shiftKey ? store.redo() : store.undo());
      if (mod && k === 'y') return void (e.preventDefault(), store.redo());
      if (mod && k === 'a') return void (e.preventDefault(), setSelection(store.ordered.filter((x) => !x.frameId && !x.hidden).map((x) => x.id)));
      if (mod && k === 'd') return void (e.preventDefault(), !readOnly && selRef.current.length && setSelection(duplicate(store, selRef.current)));
      if (mod && k === 'g') return void (e.preventDefault(), !readOnly && (e.shiftKey ? ungroup(store, selRef.current) : group(store, selRef.current)));
      if (mod && k === 'l') return void (e.preventDefault(), !readOnly && toggleLock());
      if (mod && (k === '=' || k === '+')) return void (e.preventDefault(), zoomAt(1.2, size.w / 2, size.h / 2));
      if (mod && k === '-') return void (e.preventDefault(), zoomAt(1 / 1.2, size.w / 2, size.h / 2));
      if (mod && k === '0') return void (e.preventDefault(), setView((v) => ({ z: 1, tx: v.tx + (size.w / 2 - v.tx) * (1 - 1 / v.z), ty: v.ty + (size.h / 2 - v.ty) * (1 - 1 / v.z) })));
      if (e.key === '?') return void (e.preventDefault(), setDialog({ kind: 'shortcuts' }));
      if (e.shiftKey && e.key === '!') return zoomTo();
      if (e.shiftKey && (e.key === '@' || e.key === '"')) return zoomTo(selRef.current);
      if (e.key === 'Escape') {
        setSelection([]);
        setMenu(null);
        setToolState('select');
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selRef.current.length) return void (e.preventDefault(), deleteSel());
      if (e.key === 'Enter' && selRef.current.length === 1) return void (e.preventDefault(), editText(selRef.current[0]));
      if (e.key.startsWith('Arrow') && selRef.current.length && !readOnly) {
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
        const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
        const ids = expandSelection(store, selRef.current);
        store.update(Object.fromEntries([...ids].map((id) => byId.get(id)).filter((x): x is CanvasElement => !!x && !x.locked).map((x) => [x.id, { x: x.x + dx, y: x.y + dy }])));
        return;
      }
      if (e.key === ']' || e.key === '[') return void (!readOnly && reorder(store, selRef.current, e.key === ']' ? (mod ? 'front' : 'up') : mod ? 'back' : 'down'));
      if (mod || e.altKey) return;
      // K = „KI zeichnen lassen“ (Strg+K belongs to the app's command palette)
      if (k === 'k' && !readOnly) return void (e.preventDefault(), setAiOpen(true));
      const keys: Record<string, Tool> = { v: 'select', h: 'hand', q: 'lasso', r: 'rect', o: 'ellipse', d: 'diamond', l: 'line', a: 'arrow', p: 'draw', t: 'text', s: 'sticky', f: 'frame', i: 'image', c: 'comment', x: 'eraser' };
      if (keys[k] && (!readOnly || ['select', 'hand', 'lasso', 'comment'].includes(keys[k]))) {
        if (keys[k] === 'image') return setDialog({ kind: 'media' });
        setTool(keys[k]);
      }
    };
    const onUp = (e: KeyboardEvent) => e.key === ' ' && setSpace(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onUp);
    };
  });

  const toggleLock = () => {
    const els = selRef.current.map((id) => byId.get(id)!).filter(Boolean);
    const lock = !els.every((e) => e.locked);
    store.update(Object.fromEntries(els.map((e) => [e.id, { locked: lock || (undefined as any) }])));
  };

  // --- pointer handling ----------------------------------------------------------------------------------------
  const screenPt = (e: { clientX: number; clientY: number }): Pt => {
    const r = wrap.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const worldPt = (e: { clientX: number; clientY: number }): Pt => {
    const [sx, sy] = screenPt(e);
    return toWorld(viewRef.current, sx, sy);
  };
  const tol = TOL / view.z;

  const selBox = useMemo(() => (selected.length ? selectionBox(selected, byId) : null), [selected, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const single = selected.length === 1 ? selected[0] : null;

  const handleAt = (sx: number, sy: number): { kind: 'resize'; h: Handle } | { kind: 'rotate' } | { kind: 'point'; index: number; insert: boolean } | null => {
    if (readOnly || !selected.length || selected.some((e) => e.locked)) return null;
    if (single && isLine(single)) {
      const g = lineGeometry(single, { byId });
      const pts = single.route === 'elbow' ? [g.start, g.end] : g.pts.length > 2 && single.route !== 'curved' ? g.pts : [g.start, g.end];
      const raw = single.points ?? [];
      for (let i = 0; i < pts.length; i++) {
        const [px, py] = toScreen(view, pts[i][0], pts[i][1]);
        if (Math.hypot(px - sx, py - sy) < 10) return { kind: 'point', index: i === pts.length - 1 ? Math.max(1, raw.length - 1) : i, insert: false };
      }
      if (single.route !== 'elbow' && single.route !== 'curved') {
        const all = [g.start, ...raw.slice(1, -1).map((p): Pt => [single.x + p[0], single.y + p[1]]), g.end];
        for (let i = 0; i < all.length - 1; i++) {
          const [mx, my] = toScreen(view, (all[i][0] + all[i + 1][0]) / 2, (all[i][1] + all[i + 1][1]) / 2);
          if (Math.hypot(mx - sx, my - sy) < 9) return { kind: 'point', index: i + 1, insert: true };
        }
      }
      return null;
    }
    const b = single && single.angle ? { x: single.x, y: single.y, w: single.w, h: single.h } : selBox;
    if (!b) return null;
    const [lx, ly] = single && single.angle ? localPoint(single, ...toWorld(view, sx, sy)) : toWorld(view, sx, sy);
    const [px, py] = toScreen(view, lx, ly);
    void px;
    void py;
    if (single && single.type !== 'draw') {
      const [rx, ry] = [b.x + b.w / 2, b.y - 28 / view.z];
      if (Math.hypot((lx - rx) * view.z, (ly - ry) * view.z) < 10) return { kind: 'rotate' };
    }
    for (const h of HANDLES) {
      const [hx, hy] = handlePos(b, h);
      if (Math.abs((lx - hx) * view.z) < 8 && Math.abs((ly - hy) * view.z) < 8) {
        if ((h === 'n' || h === 's' || h === 'e' || h === 'w') && (b.w * view.z < 30 || b.h * view.z < 30)) continue;
        return { kind: 'resize', h };
      }
    }
    return null;
  };

  const clearPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.cv-panel, .cv-dialog, .cv-menu, .cv-textedit, .cv-pin, .cv-empty-actions')) return;
    setFollowing(null);
    setMenu(null);
    if (editing) commitText();
    store.commit(); // a gesture that was cut short (a second finger, a lost pointer) must not swallow the next edits
    wrap.current!.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [sx, sy] = screenPt(e);
    const [wx, wy] = toWorld(view, sx, sy);
    lastWorld.current = [wx, wy];
    // long press with a finger = right click (select tool); moving, a second finger or lifting cancels it
    clearPress();
    if (e.pointerType === 'touch' && tool === 'select' && pointers.current.size === 1) {
      press.current = {
        x: e.clientX,
        y: e.clientY,
        timer: window.setTimeout(() => {
          press.current = null;
          if (pointers.current.size !== 1) return;
          setDrag(null);
          store.commit();
          const hit = hitTest(store.ordered, wx, wy, tol * 2, store.els);
          if (hit && !selRef.current.includes(hit.id)) setSelection(groupMembers(store, hit));
          setMenu({ x: sx, y: sy, world: [wx, wy] });
        }, 600),
      };
    }
    // two fingers: pinch/pan
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, view };
      if (drag?.kind === 'create' || drag?.kind === 'draw' || drag?.kind === 'line') store.remove([drag.id], { history: false });
      store.commit();
      setDrag(null);
      return;
    }
    if (e.button === 1 || tool === 'hand' || space || (e.pointerType === 'touch' && tool === 'select' && !hitTest(ordered, wx, wy, tol * 2, byId) && !handleAt(sx, sy))) {
      setDrag({ kind: 'pan', sx, sy, tx: view.tx, ty: view.ty });
      return;
    }
    if (e.button === 2) return;
    if (tool === 'comment') {
      const hit = hitTest(ordered, wx, wy, tol, byId);
      setCommentAt({ x: wx, y: wy, elementId: hit?.id ?? null });
      setPanels((p) => ({ ...p, comments: true }));
      setToolState('select');
      return;
    }
    if (tool === 'eraser') {
      const hit = hitTest(ordered, wx, wy, tol, byId);
      if (hit && !hit.locked && !readOnly) store.remove([hit.id]);
      setDrag({ kind: 'lasso', pts: [[wx, wy]], add: false });
      return;
    }
    if (readOnly && tool !== 'select' && tool !== 'lasso') return;
    if (tool === 'select' || tool === 'lasso') {
      const h = handleAt(sx, sy);
      if (h) {
        store.begin();
        if (h.kind === 'rotate' && single) return setDrag({ kind: 'rotate', id: single.id, orig: single, center: [single.x + single.w / 2, single.y + single.h / 2] });
        if (h.kind === 'point' && single) {
          if (h.insert) {
            const pts = [...(single.points ?? [[0, 0], [single.w, single.h]])];
            pts.splice(h.index, 0, [wx - single.x, wy - single.y]);
            store.update({ [single.id]: { points: pts } }, { send: false });
          }
          return setDrag({ kind: 'point', id: single.id, index: h.index, orig: byId.get(single.id)!, insert: h.insert });
        }
        if (h.kind === 'resize') {
          const ids = expandSelection(store, selection);
          return setDrag({ kind: 'resize', handle: h.h, orig: new Map([...ids].map((id) => [id, byId.get(id)!])), box: single && single.angle ? { x: single.x, y: single.y, w: single.w, h: single.h } : selBox!, single: single && single.angle ? single : null });
        }
      }
      const hit = tool === 'select' ? hitTest(ordered, wx, wy, tol, byId) : null;
      if (hit) {
        let ids: string[];
        const members = groupMembers(store, hit);
        if (e.shiftKey) ids = selection.includes(hit.id) ? selection.filter((x) => !members.includes(x)) : [...selection, ...members];
        else if (selection.includes(hit.id)) ids = selection;
        else ids = members;
        setSelection(ids);
        if (readOnly || hit.locked) return;
        // Alt-drag duplicates
        let moveIds = ids;
        if (e.altKey) moveIds = duplicate(store, ids);
        store.begin();
        const all = expandSelection(store, moveIds);
        // arrows between moved shapes come along
        for (const x of store.els.values()) if (isLine(x) && x.start && x.end && all.has(x.start.id) && all.has(x.end.id)) all.add(x.id);
        setDrag({ kind: 'move', start: [wx, wy], orig: new Map([...all].map((id) => [id, byId.get(id)!])), ids: [...all], moved: false, box: [...all].map((id) => byId.get(id)!) });
        return;
      }
      if ((e.ctrlKey || e.metaKey || tool === 'lasso') && !readOnly) return setDrag({ kind: 'lasso', pts: [[wx, wy]], add: e.shiftKey });
      if (!e.shiftKey) setSelection([]);
      setDrag({ kind: 'marquee', x0: wx, y0: wy, x1: wx, y1: wy, add: e.shiftKey });
      return;
    }
    // creating
    const frame = frameAt(ordered, wx, wy, new Set());
    const base = { x: wx, y: wy, frameId: frame && tool !== 'frame' ? frame.id : undefined, ...(tool === 'frame' ? {} : defaults) };
    const at = (props: Record<string, any>) => createElement({ ...base, ...props }, newId);
    if (tool === 'draw') {
      const el = at({ type: 'draw', points: [[0, 0, e.pressure || 0.5]], w: 0, h: 0, sketch: undefined });
      store.begin();
      store.add([el]);
      return setDrag({ kind: 'draw', id: el.id, pts: [[wx, wy, e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5]], t: performance.now(), last: [wx, wy] });
    }
    if (tool === 'line' || tool === 'arrow') {
      const target = bindTarget(ordered, wx, wy, tol, byId);
      const el = at({ type: tool, points: [[0, 0], [0, 0]], w: 0, h: 0, start: target ? { id: target.id } : undefined, frameId: undefined });
      store.begin();
      store.add([el]);
      return setDrag({ kind: 'line', id: el.id, start: [wx, wy] });
    }
    if (tool === 'text') {
      const el = at({ type: 'text', text: '', w: 200, fontSize: 20, ...defaultsText() });
      el.y -= 12;
      store.add([el], { history: false });
      setSelection([el.id]);
      setEditing({ id: el.id, value: '', isNew: true });
      setToolState('select');
      return;
    }
    if (tool === 'sticky') {
      const el = at({ type: 'sticky', x: wx - 100, y: wy - 100, fill: stickyColor, text: '', font: defaults.sketch ? 'hand' : undefined });
      store.add([el], { history: false });
      setSelection([el.id]);
      setEditing({ id: el.id, value: '', isNew: true });
      setToolState('select');
      return;
    }
    if (SHAPE_TOOLS.has(tool)) {
      const el = at(tool === 'frame' ? { type: 'frame', w: 1, h: 1, name: `Rahmen ${ordered.filter((x) => x.type === 'frame').length + 1}` } : { type: tool, w: 1, h: 1 });
      store.begin();
      store.add([el]);
      setSelection([el.id]);
      return setDrag({ kind: 'create', id: el.id, start: [wx, wy], type: tool });
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const [sx, sy] = screenPt(e);
    const [wx, wy] = toWorld(view, sx, sy);
    lastWorld.current = [wx, wy];
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 8) clearPress();
    if (!cursorsOff) store.presence({ x: round(wx), y: round(wy) });
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const p = pinch.current;
      const r = wrap.current!.getBoundingClientRect();
      const z = Math.min(8, Math.max(0.05, (p.view.z * d) / p.d));
      const cx = (a.x + b.x) / 2 - r.left;
      const cy = (a.y + b.y) / 2 - r.top;
      const [wcx, wcy] = toWorld(p.view, p.cx - r.left, p.cy - r.top);
      setView({ z, tx: cx - wcx * z, ty: cy - wcy * z });
      return;
    }
    if (!drag) {
      if (tool === 'arrow' || tool === 'line') setHoverBind(bindTarget(ordered, wx, wy, tol, byId)?.id ?? null);
      return;
    }
    const keepRatio = e.shiftKey;
    switch (drag.kind) {
      case 'pan':
        setView((v) => ({ ...v, tx: drag.tx + sx - drag.sx, ty: drag.ty + sy - drag.sy }));
        return;
      case 'marquee':
        setDrag({ ...drag, x1: wx, y1: wy });
        return;
      case 'lasso':
        if (tool === 'eraser') {
          const hit = hitTest(ordered, wx, wy, tol, byId);
          if (hit && !hit.locked && !readOnly) store.remove([hit.id]);
        }
        setDrag({ ...drag, pts: [...drag.pts, [wx, wy]] });
        return;
      case 'move': {
        let dx = wx - drag.start[0];
        let dy = wy - drag.start[1];
        if (!drag.moved && Math.hypot(dx * view.z, dy * view.z) < 3) return;
        const moving = new Set(drag.ids);
        const origBox = selectionBox([...drag.orig.values()], byId);
        let g: Guide[] = [];
        if (origBox && !e.altKey) {
          const visible = store.ordered.filter((x) => !moving.has(x.id) && !x.hidden && !isLine(x));
          const others = visible.slice(-400).map((x) => boxOf(x, byId));
          const s = snapBox({ ...origBox, x: origBox.x + dx, y: origBox.y + dy }, others, 6 / view.z);
          dx += s.dx;
          dy += s.dy;
          g = s.guides;
          if (!s.guides.length && board.settings.snap && board.settings.grid !== 'none') {
            dx = Math.round((origBox.x + dx) / 10) * 10 - origBox.x;
            dy = Math.round((origBox.y + dy) / 10) * 10 - origBox.y;
          }
        }
        setGuides(g);
        const patches: Record<string, Partial<CanvasElement>> = {};
        for (const [id, o] of drag.orig) {
          const p: Partial<CanvasElement> = { x: round(o.x + dx), y: round(o.y + dy) };
          // an arrow moved without its shapes lets go of them
          if (isLine(o)) {
            if (o.start && !moving.has(o.start.id)) p.start = undefined;
            if (o.end && !moving.has(o.end.id)) p.end = undefined;
            if (o.start && !moving.has(o.start.id) || o.end && !moving.has(o.end.id)) {
              const geo = lineGeometry(o, { byId });
              const pts = o.route === 'elbow' ? [geo.start, geo.end] : [geo.start, ...(o.points ?? []).slice(1, -1).map((q): Pt => [o.x + q[0], o.y + q[1]]), geo.end];
              const fitted = fitToPoints({ ...o, x: 0, y: 0, points: pts.map((q) => [q[0] + dx, q[1] + dy]) });
              Object.assign(p, { x: fitted.x, y: fitted.y, w: fitted.w, h: fitted.h, points: fitted.points });
            }
          }
          patches[id] = p;
        }
        store.update(patches, { send: false });
        if (!drag.moved) setDrag({ ...drag, moved: true });
        return;
      }
      case 'resize': {
        const patches: Record<string, Partial<CanvasElement>> = {};
        if (drag.single) {
          const o = drag.single;
          const [lx, ly] = localPoint(o, wx, wy);
          const nb = resizeBox(drag.box, drag.handle, lx, ly, keepRatio || o.type === 'image' || o.type === 'icon', e.altKey);
          // keep the opposite corner in place in board space (rotation around the new centre)
          const a = ((o.angle ?? 0) * Math.PI) / 180;
          const oc: Pt = [o.x + o.w / 2, o.y + o.h / 2];
          const nc: Pt = [nb.x + nb.w / 2, nb.y + nb.h / 2];
          const d: Pt = [nc[0] - oc[0], nc[1] - oc[1]];
          const rc: Pt = [oc[0] + d[0] * Math.cos(a) - d[1] * Math.sin(a), oc[1] + d[0] * Math.sin(a) + d[1] * Math.cos(a)];
          patches[o.id] = { x: round(rc[0] - nb.w / 2), y: round(rc[1] - nb.h / 2), w: round(Math.max(4, nb.w)), h: round(Math.max(4, nb.h)) };
        } else {
          const nb = resizeBox(drag.box, drag.handle, wx, wy, keepRatio || [...drag.orig.values()].some((o) => o.type === 'image' || o.type === 'icon') || drag.orig.size > 1 && drag.handle.length === 2, e.altKey);
          for (const [id, o] of drag.orig) {
            if (o.type === 'text' && drag.orig.size === 1) {
              if (drag.handle.length === 2) {
                const k = nb.h / Math.max(1, drag.box.h);
                const fs = Math.max(6, Math.round((o.fontSize ?? 20) * k));
                const sized = sizedText({ ...o, fontSize: fs, w: Math.max(10, round(nb.w)) });
                patches[id] = { x: round(nb.x), y: round(nb.y), w: sized.w, h: sized.h, fontSize: fs };
              } else {
                const sized = sizedText({ ...o, w: Math.max(20, round(nb.w)) });
                patches[id] = { x: round(nb.x), w: sized.w, h: sized.h };
              }
              continue;
            }
            const p = scaleElement(o, drag.box, nb);
            if (o.type === 'text') p.fontSize = Math.max(6, Math.round((o.fontSize ?? 20) * (nb.h / Math.max(1, drag.box.h))));
            patches[id] = p;
          }
        }
        store.update(patches, { send: false });
        return;
      }
      case 'rotate': {
        let deg = (Math.atan2(wy - drag.center[1], wx - drag.center[0]) * 180) / Math.PI + 90;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        store.update({ [drag.id]: { angle: round(((deg % 360) + 360) % 360) || (undefined as any) } }, { send: false });
        return;
      }
      case 'create': {
        let x1 = drag.start[0];
        let y1 = drag.start[1];
        let w = wx - x1;
        let h = wy - y1;
        if (keepRatio) {
          const m = Math.max(Math.abs(w), Math.abs(h));
          w = Math.sign(w || 1) * m;
          h = Math.sign(h || 1) * m;
        }
        if (e.altKey) {
          x1 -= w;
          y1 -= h;
          w *= 2;
          h *= 2;
        }
        store.update({ [drag.id]: { x: round(Math.min(x1, x1 + w)), y: round(Math.min(y1, y1 + h)), w: round(Math.abs(w)), h: round(Math.abs(h)) } }, { send: false });
        return;
      }
      case 'line': {
        const el = byId.get(drag.id);
        if (!el) return;
        const target = bindTarget(ordered, wx, wy, tol, byId, drag.id);
        setHoverBind(target?.id ?? null);
        let ex = wx;
        let ey = wy;
        if (keepRatio) {
          const ang = Math.round(Math.atan2(wy - drag.start[1], wx - drag.start[0]) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(wx - drag.start[0], wy - drag.start[1]);
          ex = drag.start[0] + Math.cos(ang) * len;
          ey = drag.start[1] + Math.sin(ang) * len;
        }
        const fitted = fitToPoints({ ...el, x: 0, y: 0, points: [[drag.start[0], drag.start[1]], [ex, ey]] });
        store.update({ [drag.id]: { x: fitted.x, y: fitted.y, w: fitted.w, h: fitted.h, points: fitted.points, end: target && target.id !== el.start?.id ? { id: target.id } : (undefined as any) } }, { send: false });
        return;
      }
      case 'point': {
        const el = byId.get(drag.id);
        if (!el) return;
        const pts = (el.points ?? [[0, 0], [el.w, el.h]]).map((p): Pt => [el.x + p[0], el.y + p[1]]);
        const isEnd = !drag.insert && (drag.index === 0 || drag.index === pts.length - 1);
        const target = isEnd ? bindTarget(ordered, wx, wy, tol, byId, drag.id) : null;
        setHoverBind(target?.id ?? null);
        pts[drag.index] = [wx, wy];
        const fitted = fitToPoints({ ...el, x: 0, y: 0, points: pts });
        const p: Partial<CanvasElement> = { x: fitted.x, y: fitted.y, w: fitted.w, h: fitted.h, points: fitted.points };
        if (isEnd) p[drag.index === 0 ? 'start' : 'end'] = target ? { id: target.id } : (undefined as any);
        store.update({ [drag.id]: p }, { send: false });
        return;
      }
      case 'draw': {
        const now = performance.now();
        const dist = Math.hypot(wx - drag.last[0], wy - drag.last[1]);
        if (dist * view.z < 1.2) return;
        // pens report pressure; for mice and fingers speed stands in for it (fast = thin)
        const speed = dist / Math.max(1, now - drag.t);
        const p = e.pointerType === 'pen' && e.pressure ? e.pressure : Math.max(0.15, Math.min(0.85, 0.75 - speed * 0.35));
        const pts = [...drag.pts, [wx, wy, round(p)]];
        const el = byId.get(drag.id)!;
        const fitted = fitToPoints({ ...el, x: 0, y: 0, points: pts });
        store.update({ [drag.id]: { x: fitted.x, y: fitted.y, w: fitted.w, h: fitted.h, points: fitted.points } }, { send: false });
        setDrag({ ...drag, pts, t: now, last: [wx, wy] });
        return;
      }
    }
  };

  const finishDrag = (e: React.PointerEvent) => {
    clearPress();
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const d = drag;
    setDrag(null);
    setGuides([]);
    setHoverBind(null);
    if (!d) return;
    const send = (ids: string[]) => {
      store.sendDirty(ids);
      store.commit();
    };
    switch (d.kind) {
      case 'marquee': {
        const r = { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) };
        if (r.w * view.z < 3 && r.h * view.z < 3) return;
        const found = inRect(ordered.filter((x) => !x.frameId || !inRect([byId.get(x.frameId)!].filter(Boolean), r, byId).length), r, byId).flatMap((x) => groupMembers(store, x));
        setSelection(d.add ? [...new Set([...selection, ...found])] : [...new Set(found)]);
        return;
      }
      case 'lasso': {
        if (tool === 'eraser') return;
        const found = inLasso(ordered.filter((x) => !x.frameId), d.pts, byId).flatMap((x) => groupMembers(store, x));
        setSelection(d.add ? [...new Set([...selection, ...found])] : [...new Set(found)]);
        return;
      }
      case 'move': {
        if (!d.moved) {
          store.commit();
          return;
        }
        // frame membership by the element's centre
        const moving = new Set(d.ids);
        for (const id of d.ids) {
          const el = byId.get(id);
          if (!el || el.type === 'frame' || isLine(el) || (el.frameId && moving.has(el.frameId))) continue;
          const b = elementBox(el);
          const f = frameAt(ordered, b.x + b.w / 2, b.y + b.h / 2, moving);
          if ((f?.id ?? undefined) !== (el.frameId ?? undefined)) store.update({ [id]: { frameId: f?.id ?? (undefined as any) } }, { send: false });
        }
        send(d.ids);
        return;
      }
      case 'resize':
        send([...d.orig.keys()]);
        return;
      case 'rotate':
      case 'point':
        send([d.id]);
        return;
      case 'create': {
        const el = byId.get(d.id);
        if (el && el.w < 4 && el.h < 4) {
          const def = defaultsFor(el.type);
          const preset = el.type === 'frame' ? FRAME_PRESETS.find((p) => p.key === 'desktop')! : null;
          const w = preset ? preset.w : (def.w ?? 120);
          const h = preset ? preset.h : (def.h ?? 80);
          store.update({ [d.id]: { x: round(d.start[0] - w / 2), y: round(d.start[1] - h / 2), w, h, ...(preset ? { preset: preset.key } : {}) } }, { send: false });
        }
        if (el?.type === 'frame') {
          // things already lying inside the new frame become its contents
          const f = byId.get(d.id)!;
          const inside = ordered.filter((x) => x.id !== f.id && !x.frameId && x.type !== 'frame' && !isLine(x)).filter((x) => {
            const b = elementBox(x);
            return b.x >= f.x && b.y >= f.y && b.x + b.w <= f.x + f.w && b.y + b.h <= f.y + f.h;
          });
          if (inside.length) store.update(Object.fromEntries(inside.map((x) => [x.id, { frameId: f.id }])), { send: false });
          send([d.id, ...inside.map((x) => x.id)]);
        } else send([d.id]);
        setToolState('select');
        if (el && el.type !== 'frame' && el.type !== 'image') setEditing(null);
        return;
      }
      case 'line': {
        const el = byId.get(d.id);
        if (!el) return store.commit();
        if (el.w < 3 && el.h < 3 && !el.end) {
          store.remove([d.id], { history: false });
          store.commit();
          return;
        }
        send([d.id]);
        setSelection([d.id]);
        setToolState('select');
        return;
      }
      case 'draw':
        send([d.id]);
        return;
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.cv-panel, .cv-dialog, .cv-menu, .cv-textedit, .cv-empty-actions')) return;
    const [wx, wy] = worldPt(e);
    const hit = hitTest(ordered, wx, wy, tol, byId);
    if (hit) {
      if (hit.groupIds?.length && selection.length > 1) setSelection([hit.id]);
      if (hit.type === 'card') return cardOpen(hit);
      return editText(hit.id);
    }
    if (readOnly) return;
    const el = createElement({ type: 'text', x: wx, y: wy - 12, text: '', w: 200, fontSize: 20, frameId: frameAt(ordered, wx, wy, new Set())?.id, ...defaultsText() }, newId);
    store.add([el], { history: false });
    setSelection([el.id]);
    setEditing({ id: el.id, value: '', isNew: true });
  };

  const onContextMenu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.cv-panel, .cv-dialog, textarea')) return;
    e.preventDefault();
    const [sx, sy] = screenPt(e);
    const [wx, wy] = toWorld(view, sx, sy);
    const hit = hitTest(ordered, wx, wy, tol, byId);
    if (hit && !selection.includes(hit.id)) setSelection(groupMembers(store, hit));
    setMenu({ x: sx, y: sy, world: [wx, wy] });
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    if (readOnly) return;
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
    const [wx, wy] = worldPt(e);
    for (const [i, f] of files.slice(0, 10).entries()) await addImageFile(f, [wx + i * 30, wy + i * 30]);
  };

  // --- API for panels ---------------------------------------------------------------------------------------------
  const apiObj: EditorApi = {
    store,
    board,
    readOnly,
    selection,
    select,
    selected,
    view,
    setView,
    size,
    tool,
    setTool,
    dark,
    center,
    zoomTo,
    insert,
    patch,
    open: (kind, data) => setDialog({ kind, data }),
    refreshCards,
    saveBoard,
    editText,
    catchUpCreated,
    comments: { open: panels.comments, toggle: () => setPanels((p) => ({ ...p, comments: !p.comments })), focus: (c) => focusOn(c) },
    defaults,
    setDefaults: (p) => setDefaultsState((d) => ({ ...d, ...p })),
  };
  const focusOn = (c: Comment) => {
    if (c.element_id && byId.has(c.element_id)) {
      setSelection([c.element_id]);
      zoomTo([c.element_id]);
    } else if (c.x !== null && c.y !== null) setView((v) => ({ ...v, tx: size.w / 2 - c.x! * v.z, ty: size.h / 2 - c.y! * v.z }));
  };

  // --- rendering ---------------------------------------------------------------------------------------------------
  const vis = { x: -view.tx / view.z - 200 / view.z, y: -view.ty / view.z - 200 / view.z, w: size.w / view.z + 400 / view.z, h: size.h / view.z + 400 / view.z };
  const CELL = 400;
  const cull = { x1: Math.floor(vis.x / CELL) * CELL, y1: Math.floor(vis.y / CELL) * CELL, x2: Math.ceil((vis.x + vis.w) / CELL) * CELL, y2: Math.ceil((vis.y + vis.h) / CELL) * CELL };
  const tree = useMemo(() => renderTree(ordered), [ordered]);
  const frames = ordered.filter((e) => e.type === 'frame' && !e.hidden);

  const S = (x: number, y: number) => toScreen(view, x, y);
  const cursor = drag?.kind === 'pan' || space ? 'grabbing' : tool === 'hand' ? 'grab' : tool === 'select' ? 'default' : tool === 'comment' ? 'copy' : tool === 'eraser' ? 'not-allowed' : 'crosshair';
  const gridSize = 20 * view.z;
  const showGrid = board.settings.grid !== 'none' && gridSize >= 6;

  // selection overlay
  const overlay: ReactNode[] = [];
  const outline = (el: CanvasElement, color: string, key: string, dash?: string) => {
    if (isLine(el)) {
      const g = lineGeometry(el, { byId });
      overlay.push(<polyline key={key} points={g.pts.map((p) => S(p[0], p[1]).join(',')).join(' ')} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray={dash} opacity={0.8} />);
      return;
    }
    const a = ((el.angle ?? 0) * Math.PI) / 180;
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    const corners = [[el.x, el.y], [el.x + el.w, el.y], [el.x + el.w, el.y + el.h], [el.x, el.y + el.h]].map(([x, y]) => S(cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)));
    overlay.push(<polygon key={key} points={corners.map((c) => c.join(',')).join(' ')} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray={dash} />);
  };
  for (const el of selected) outline(el, '#4c6ef5', `sel-${el.id}`);
  for (const v of store.viewers.values()) for (const id of v.sel ?? []) {
    const el = byId.get(id);
    if (el) outline(el, v.color, `rs-${v.clientId}-${id}`, '4 3');
  }
  if (hoverBind) {
    const t = byId.get(hoverBind);
    if (t) outline(t, '#40c057', 'bind');
  }
  if (selBox && !drag && !readOnly && !selected.some((x) => x.locked)) {
    if (single && isLine(single)) {
      const g = lineGeometry(single, { byId });
      const pts = single.route === 'elbow' || single.route === 'curved' ? [g.start, g.end] : [g.start, ...(single.points ?? []).slice(1, -1).map((p): Pt => [single.x + p[0], single.y + p[1]]), g.end];
      pts.forEach((p, i) => {
        const [x, y] = S(p[0], p[1]);
        overlay.push(<circle key={`pt${i}`} cx={x} cy={y} r={5.5} className="cv-handle" />);
      });
      if (single.route !== 'elbow' && single.route !== 'curved')
        for (let i = 0; i < pts.length - 1; i++) {
          const [x, y] = S((pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
          overlay.push(<circle key={`mid${i}`} cx={x} cy={y} r={4} className="cv-handle mid" />);
        }
    } else {
      const rotated = single && single.angle;
      const b = rotated ? { x: single!.x, y: single!.y, w: single!.w, h: single!.h } : selBox;
      const a = rotated ? ((single!.angle ?? 0) * Math.PI) / 180 : 0;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const T = (x: number, y: number) => S(cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a));
      if (selected.length > 1) {
        const c = [T(b.x, b.y), T(b.x + b.w, b.y), T(b.x + b.w, b.y + b.h), T(b.x, b.y + b.h)];
        overlay.push(<polygon key="selbox" points={c.map((p) => p.join(',')).join(' ')} fill="none" stroke="#4c6ef5" strokeWidth={1} strokeDasharray="5 4" />);
      }
      for (const h of HANDLES) {
        if ((h.length === 1) && (b.w * view.z < 30 || b.h * view.z < 30)) continue;
        const [x, y] = T(...handlePos(b, h));
        overlay.push(<rect key={h} x={x - 4.5} y={y - 4.5} width={9} height={9} rx={2} className="cv-handle" />);
      }
      if (single && single.type !== 'draw') {
        const [x, y] = T(b.x + b.w / 2, b.y - 28 / view.z);
        const [x0, y0] = T(b.x + b.w / 2, b.y);
        overlay.push(<line key="rotl" x1={x0} y1={y0} x2={x} y2={y} stroke="#4c6ef5" strokeWidth={1} />, <circle key="rot" cx={x} cy={y} r={5.5} className="cv-handle rot" />);
      }
    }
  }
  for (const g of guides) {
    const [x1, y1] = S(g.x1, g.y1);
    const [x2, y2] = S(g.x2, g.y2);
    overlay.push(<line key={`g${x1},${y1},${x2},${y2}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#f03e3e" strokeWidth={1} strokeDasharray="3 3" />);
  }
  if (drag?.kind === 'marquee') {
    const [x1, y1] = S(drag.x0, drag.y0);
    const [x2, y2] = S(drag.x1, drag.y1);
    overlay.push(<rect key="mq" x={Math.min(x1, x2)} y={Math.min(y1, y2)} width={Math.abs(x2 - x1)} height={Math.abs(y2 - y1)} className="cv-marquee" />);
  }
  if (drag?.kind === 'lasso' && tool !== 'eraser') overlay.push(<polygon key="lasso" points={drag.pts.map((p) => S(p[0], p[1]).join(',')).join(' ')} className="cv-marquee" />);

  // remote cursors
  const cursors = [...store.viewers.values()].filter((v) => !cursorsOff && v.x !== undefined && v.y !== undefined).map((v) => {
    const [x, y] = S(v.x!, v.y!);
    if (x < -50 || y < -50 || x > size.w + 50 || y > size.h + 50) return null;
    return (
      <div key={v.clientId} className={`cv-cursor${v.kind === 'agent' ? ' agent' : ''}`} style={{ transform: `translate(${x}px, ${y}px)`, ['--c' as any]: v.color }}>
        {v.kind === 'agent' ? <span className="cv-cursor-bot">✦</span> : <svg width="18" height="18" viewBox="0 0 18 18"><path d="M1 1 L1 15 L5 11 L8 17 L10.5 16 L7.5 10 L13 10 Z" fill={v.color} stroke="#fff" strokeWidth="1.2" /></svg>}
        <span>{v.name}</span>
      </div>
    );
  });

  // text editor
  const editEl = editing ? byId.get(editing.id) : null;
  let textEditor: ReactNode = null;
  if (editing && editEl) {
    const fs = (editEl.type === 'frame' ? 14 : (editEl.fontSize ?? (isLine(editEl) ? 16 : 20))) * view.z;
    const font = FONT_STACK[editEl.font ?? 'sans'];
    let box: { x: number; y: number; w: number; h: number };
    let align = editEl.align ?? (editEl.type === 'text' ? 'left' : 'center');
    if (editEl.type === 'frame') {
      box = { x: editEl.x, y: editEl.y - 24, w: Math.max(160, editEl.w), h: 22 };
      align = 'left';
    } else if (isLine(editEl)) {
      const g = lineGeometry(editEl, { byId });
      const mid = g.pts[Math.floor(g.pts.length / 2)];
      box = { x: mid[0] - 120, y: mid[1] - 18, w: 240, h: 36 };
    } else if (editEl.type === 'text') {
      const lines = Math.max(1, layoutText(editing.value || ' ', editEl.fontSize ?? 20, { maxWidth: editEl.w, font: editEl.font, bold: editEl.bold }).lines.length);
      box = { x: editEl.x, y: editEl.y, w: Math.max(editEl.w, 40), h: lines * (editEl.fontSize ?? 20) * LINE_HEIGHT + 4 };
    } else {
      const pad = editEl.type === 'sticky' ? 16 : 10;
      box = { x: editEl.x + pad, y: editEl.y + pad, w: editEl.w - pad * 2, h: editEl.h - pad * 2 };
    }
    const [x, y] = S(box.x, box.y);
    textEditor = (
      <textarea
        ref={textRef}
        className="cv-textedit"
        value={editing.value}
        spellCheck
        onChange={(e) => {
          const value = e.target.value;
          setEditing({ ...editing, value });
          if (editEl.type === 'text') {
            const sized = sizedText({ ...editEl, text: value }, editing.isNew);
            store.update({ [editEl.id]: { w: sized.w, h: sized.h } }, { history: false, send: false });
          }
        }}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) || (e.key === 'Enter' && editEl.type === 'frame')) {
            e.preventDefault();
            commitText();
          }
          e.stopPropagation();
        }}
        style={{
          left: x,
          top: y,
          width: box.w * view.z,
          height: editEl.type === 'text' || editEl.type === 'frame' || isLine(editEl) ? box.h * view.z : box.h * view.z,
          fontSize: fs,
          fontFamily: font,
          fontWeight: editEl.bold ? 700 : 400,
          fontStyle: editEl.italic ? 'italic' : 'normal',
          lineHeight: LINE_HEIGHT,
          textAlign: align,
          color: dark ? '#e9ecef' : (editEl.color ?? '#1e1e1e'),
          transform: editEl.angle && !isLine(editEl) && editEl.type !== 'frame' ? `rotate(${editEl.angle}deg)` : undefined,
          transformOrigin: `${((editEl.x + editEl.w / 2 - box.x) / Math.max(1, box.w)) * 100}% ${((editEl.y + editEl.h / 2 - box.y) / Math.max(1, box.h)) * 100}%`,
          paddingTop: editEl.type !== 'text' && editEl.type !== 'frame' && !isLine(editEl) ? Math.max(0, (box.h * view.z - fs * LINE_HEIGHT * Math.max(1, editing.value.split('\n').length)) / 2) : 0,
        }}
      />
    );
  }

  const menuItems = menu ? contextItems() : [];
  function contextItems(): ([string, () => void, string?] | null)[] {
    const has = selected.length > 0;
    const items: ([string, () => void, string?] | null)[] = [];
    if (has) {
      items.push(['Kopieren', () => document.execCommand('copy'), 'Strg C']);
      if (!readOnly) items.push(['Ausschneiden', () => document.execCommand('cut'), 'Strg X'], ['Duplizieren', () => setSelection(duplicate(store, selection)), 'Strg D'], ['Löschen', deleteSel, 'Entf']);
      items.push(null);
      if (!readOnly) {
        items.push(['Ganz nach vorne', () => reorder(store, selection, 'front'), 'Strg ]'], ['Nach vorne', () => reorder(store, selection, 'up'), ']'], ['Nach hinten', () => reorder(store, selection, 'down'), '['], ['Ganz nach hinten', () => reorder(store, selection, 'back'), 'Strg [']);
        items.push(null);
        if (selected.length > 1) items.push(['Gruppieren', () => group(store, selection), 'Strg G']);
        if (selected.some((x) => x.groupIds?.length)) items.push(['Gruppierung aufheben', () => ungroup(store, selection), 'Strg ⇧ G']);
        items.push([selected.every((x) => x.locked) ? 'Entsperren' : 'Sperren', toggleLock, 'Strg L']);
        if (selected.length > 1) items.push(['Links ausrichten', () => align(store, selection, 'left')], ['Mittig ausrichten', () => align(store, selection, 'hcenter')], ['Oben ausrichten', () => align(store, selection, 'top')]);
        if (selected.length > 2) items.push(['Horizontal verteilen', () => distribute(store, selection, 'h')], ['Vertikal verteilen', () => distribute(store, selection, 'v')]);
        items.push(null);
        if (selected.some((x) => (x.text ?? '').trim() && x.type !== 'card')) items.push(['Als Aufgabe anlegen', () => convert('task')], ['Als Deal anlegen', () => setDialog({ kind: 'deal', data: { ids: selection } })]);
      }
      items.push(['Kommentieren', () => (setCommentAt({ x: menu!.world[0], y: menu!.world[1], elementId: selection[0] }), setPanels((p) => ({ ...p, comments: true })))]);
      items.push(['Auswahl exportieren …', () => setDialog({ kind: 'export', data: { scope: 'selection' } })]);
      items.push(['Auswahl einpassen', () => zoomTo(selection), '⇧ 2']);
    } else {
      if (!readOnly) items.push(['Einfügen', () => void pasteFromMenu(), 'Strg V'], ['Vorlage einfügen …', () => setDialog({ kind: 'templates' })], ['CRM-Karte einfügen …', () => setDialog({ kind: 'crm' })], ['Bild einfügen …', () => setDialog({ kind: 'media' })], null);
      items.push(['Alles auswählen', () => setSelection(store.ordered.filter((x) => !x.frameId).map((x) => x.id)), 'Strg A'], ['Alles einpassen', () => zoomTo(), '⇧ 1'], ['Kommentar hier', () => (setCommentAt({ x: menu!.world[0], y: menu!.world[1], elementId: null }), setPanels((p) => ({ ...p, comments: true })))]);
    }
    return items;
  }
  const pasteFromMenu = async () => {
    let text = clip.current;
    try {
      text = (await navigator.clipboard.readText()) || text;
    } catch {
      /* no permission: use our own clipboard */
    }
    const ours = parseClipboard(text);
    if (ours) setSelection(pasteAt(store, ours, menu ? { x: menu.world[0], y: menu.world[1] } : null));
  };
  const convert = async (to: 'task') => {
    const ids = selected.filter((x) => (x.text ?? '').trim() && x.type !== 'card').map((x) => x.id);
    if (!ids.length) return;
    await store.flush();
    const r = await act(() => api.post(`/api/canvas/${board.id}/convert`, { element_ids: ids, to, clientId: store.clientId }), `${ids.length === 1 ? 'Aufgabe' : `${ids.length} Aufgaben`} angelegt – als Live-Karte auf dem Board`);
    if (r) await catchUpCreated();
  };

  const viewers = [...store.viewers.values()];
  const me = session.user;
  const people = [{ clientId: 'me', name: me.name, color: '#4c6ef5', kind: 'user' as const }, ...viewers.filter((v) => !viewers.some((o) => o.userId && o.userId === v.userId && o.at > v.at && o.clientId !== v.clientId))];

  return (
    <div className={`cv${dark ? ' cv-dark' : ''}`} data-tour="canvas-editor">
      <header className="cv-head" data-tour="canvas-head">
        <button className="icon-btn" onClick={onBack} aria-label="Zurück zu allen Boards" title="Alle Boards">
          <Icon name="up" style={{ transform: 'rotate(-90deg)' }} />
        </button>
        <input className="cv-title" value={board.name} readOnly={readOnly} onChange={(e) => setBoard({ ...board, name: e.target.value })} onBlur={() => !readOnly && board.name.trim() && saveBoard({ name: board.name.trim() })} aria-label="Name des Boards" />
        {readOnly && <span className="badge gray">Nur ansehen</span>}
        <span className={`cv-status ${store.status}`} title={store.status === 'offline' ? 'Keine Verbindung – Änderungen werden gesendet, sobald sie wieder da ist' : store.status === 'saving' ? 'Speichert …' : 'Gespeichert, live verbunden'}>
          {store.status === 'offline' ? 'Offline' : store.status === 'saving' ? 'Speichert …' : 'Live'}
        </span>
        <CanvasPeople people={people} following={following} onFollow={setFollowing} />
        <div className="cv-head-actions">
          <button className={`btn small secondary${panels.comments ? ' on' : ''}`} onClick={() => setPanels((p) => ({ ...p, comments: !p.comments }))} data-tour="canvas-comments" title="Kommentare">
            <Icon name="chat" /> <span className="cv-hide-sm">{store.comments.filter((c) => !c.resolved_at && !c.parent_id).length || ''}</span>
          </button>
          <button className="btn small secondary" onClick={() => setDialog({ kind: 'history' })} title="Versionen" data-tour="canvas-history">
            <Icon name="schedule" />
          </button>
          <XrButton kind="canvas" id={board.id} name={board.name} />
          <button className="btn small secondary" onClick={() => setDialog({ kind: 'export' })} aria-label="Export" data-tour="canvas-export">
            <Icon name="download" /> <span className="cv-hide-sm">Export</span>
          </button>
          <button className="btn small" onClick={() => setDialog({ kind: 'share' })} aria-label="Teilen" data-tour="canvas-share">
            <Icon name="link" /> <span className="cv-hide-sm">Teilen</span>
          </button>
        </div>
      </header>
      <div
        ref={wrap}
        className="cv-stage"
        style={{ cursor }}
        onMouseDown={(e) => {
          // no text selection or focus jumps while drawing; a focused field (title, composer) lets go
          if ((e.target as HTMLElement).closest('textarea, input, select, button, a')) return;
          e.preventDefault();
          const a = document.activeElement as HTMLElement | null;
          if (a && !a.classList.contains('cv-textedit')) a.blur();
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        data-tour="canvas-stage"
      >
        <svg className="cv-grid" width={size.w} height={size.h} aria-hidden="true">
          {showGrid && (
            <>
              <defs>
                <pattern id="cv-grid" width={gridSize} height={gridSize} patternUnits="userSpaceOnUse" x={view.tx % gridSize} y={view.ty % gridSize}>
                  {board.settings.grid === 'lines' ? <path d={`M ${gridSize} 0 L 0 0 0 ${gridSize}`} fill="none" className="cv-gridline" /> : <circle cx={1} cy={1} r={Math.min(1.4, 0.6 + view.z * 0.4)} className="cv-griddot" />}
                </pattern>
              </defs>
              <rect width="100%" height="100%" fill="url(#cv-grid)" />
            </>
          )}
        </svg>
        <svg className="cv-scene" width={size.w} height={size.h}>
          <defs>
            {frames.map((f) => (
              <clipPath key={f.id} id={`fc-${f.id}`}>
                <rect x={f.x} y={f.y} width={f.w} height={f.h} rx={f.radius ?? 0} />
              </clipPath>
            ))}
          </defs>
          <g transform={`matrix(${view.z} 0 0 ${view.z} ${view.tx} ${view.ty})`}>
            <Scene tree={tree} byId={byId} cards={store.cards} editingId={editing?.id} dark={dark} rev={rev} {...cull} />
          </g>
        </svg>
        <svg className="cv-overlay" width={size.w} height={size.h}>
          {overlay}
        </svg>
        <CommentPins api={apiObj} onOpen={(c) => (setPanels((p) => ({ ...p, comments: true })), setFocusComment(c.id))} />
        <div className="cv-cursors">{cursors}</div>
        {textEditor}
        {!ordered.length && !readOnly && (
          <div className="cv-empty" data-tour="canvas-empty">
            <h2>Leeres Board</h2>
            <p>Zeichne los (Werkzeuge oben), wähle eine Vorlage oder lass die KI etwas zeichnen.</p>
            <div className="cv-empty-actions">
              <button className="btn" onClick={() => setDialog({ kind: 'templates' })}>
                Vorlage wählen
              </button>
              <button className="btn secondary" onClick={() => setAiOpen(true)}>
                <Icon name="ai" /> KI zeichnen lassen
              </button>
            </div>
          </div>
        )}
      </div>
      {!readOnly && <Toolbar api={apiObj} />}
      <div className="cv-bottom-left cv-panel" data-tour="canvas-zoom">
        <button className="icon-btn" onClick={() => store.undo()} disabled={!store.canUndo() || readOnly} title="Rückgängig (Strg Z)" aria-label="Rückgängig">
          <Icon name="undo" />
        </button>
        <button className="icon-btn" onClick={() => store.redo()} disabled={!store.canRedo() || readOnly} title="Wiederholen (Strg Y)" aria-label="Wiederholen">
          <Icon name="redo" />
        </button>
        <span className="cv-sep" />
        <button className="icon-btn" onClick={() => zoomAt(1 / 1.25, size.w / 2, size.h / 2)} aria-label="Verkleinern">
          −
        </button>
        <button className="cv-zoom" onClick={() => zoomTo()} title="Alles einpassen (⇧ 1)">
          {Math.round(view.z * 100)} %
        </button>
        <button className="icon-btn" onClick={() => zoomAt(1.25, size.w / 2, size.h / 2)} aria-label="Vergrößern">
          +
        </button>
        <span className="cv-sep" />
        <button className={`icon-btn${panels.layers ? ' on' : ''}`} onClick={() => setPanels((p) => ({ ...p, layers: !p.layers }))} title="Ebenen" aria-label="Ebenen" data-tour="canvas-layers">
          <Icon name="layers" />
        </button>
        <button className={`icon-btn cv-hide-sm${panels.minimap ? ' on' : ''}`} onClick={() => setPanels((p) => ({ ...p, minimap: !p.minimap }))} title="Übersichtskarte" aria-label="Übersichtskarte">
          <Icon name="grid" />
        </button>
      </div>
      {panels.minimap && <Minimap api={apiObj} />}
      {panels.layers && <LayersPanel api={apiObj} onClose={() => setPanels((p) => ({ ...p, layers: false }))} />}
      {(selected.length > 0 || CREATE_TOOLS.has(tool)) && !panels.comments && <Inspector api={apiObj} />}
      {panels.comments && (
        <CommentsPanel
          api={apiObj}
          draft={commentAt}
          focusId={focusComment}
          onDraftDone={() => setCommentAt(null)}
          onClose={() => (setPanels((p) => ({ ...p, comments: false })), setCommentAt(null), setFocusComment(null))}
        />
      )}
      <AiBar api={apiObj} open={aiOpen} setOpen={setAiOpen} />
      {menu && (
        <div className="cv-menu" style={{ left: Math.min(menu.x, size.w - 230), top: Math.min(menu.y + 52, size.h - 20) }} onPointerDown={(e) => e.stopPropagation()}>
          {menuItems.map((it, i) =>
            it ? (
              <button
                key={i}
                onClick={() => {
                  setMenu(null);
                  it[1]();
                }}
              >
                <span>{it[0]}</span>
                {it[2] && <kbd>{it[2]}</kbd>}
              </button>
            ) : (
              <hr key={i} />
            ),
          )}
        </div>
      )}
      {dialog && <Dialogs api={apiObj} kind={dialog.kind} data={dialog.data} onClose={() => setDialog(null)} />}
    </div>
  );
}
