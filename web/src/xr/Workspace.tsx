import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../api';
import { contextRoute } from '../agent/context';
import { Icon } from '../icons';
import { PageSuspense, lazyPages } from '../lazy';
import { Check, Modal, RouteScope, navigate, setNavHook, toastError } from '../ui';
import { subscribeSelection } from './selection';
import {
  PAGES,
  addPanel,
  applyCount,
  defaultState,
  fromLayout,
  isCompact,
  maxPanelsFor,
  movePanel,
  removePanel,
  resizeBetween,
  routeLabel,
  setPanelRoute,
  selectContact,
  splitterKey,
  targetPanel,
  toLayout,
  toParts,
  toRoute,
  type WorkspaceState,
} from './workspace-layout';
import { XR_LIMITS, cleanWorkspace, type WorkspaceLayout } from '../../../server/services/xr-model';
import './workspace.css';

const { AgentPanel } = lazyPages(() => import('../agent/Panel'), 'AgentPanel');

/**
 * Arbeitsfläche: two to four pages side by side – Inbox | Kontakt | Board | Agent on a 21:9 or 32:9 screen (display glasses, a big
 * virtual screen in a headset). Each panel is a real page of the app with its own route; a link inside a panel opens in the
 * panel that already shows that kind of page, a pick in the inbox updates the contact panel (selection.ts). Panels have splitters
 * you can drag or move with the keyboard; the arrangement is saved per person (/api/xr/workspace). Below 1000 px it falls back
 * to one page at a time – normal navigation. Rules: workspace-layout.ts. Docs: docs/xr.md.
 */

const CACHE_KEY = 'pghl.workspace';

function readCache(): WorkspaceLayout | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? cleanWorkspace(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
function writeCache(l: WorkspaceLayout) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(l));
  } catch {
    /* storage blocked: the server copy is the one that counts */
  }
}

function useWidth(ref: { current: HTMLElement | null }): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    setW(el.clientWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** The HyperLevel Agent inside a panel: the same chat as the drawer, without the drawer. */
function EmbeddedAgent() {
  const [ready] = useState(() => {
    // The drawer opens from this saved flag; remember the person's own state and give it back when the panel goes.
    let was: string | null = null;
    try {
      was = localStorage.getItem('pghl.agent.open');
      localStorage.setItem('pghl.agent.open', '1');
    } catch {
      /* ignore */
    }
    return was;
  });
  useEffect(() => {
    document.documentElement.dataset.wsAgent = '1';
    return () => {
      delete document.documentElement.dataset.wsAgent;
      try {
        localStorage.setItem('pghl.agent.open', ready === '1' ? '1' : '0');
      } catch {
        /* ignore */
      }
    };
  }, [ready]);
  return (
    <>
      <div className="ws-agent">
        <AgentPanel />
      </div>
      <div className="ws-agent-closed">
        <p className="muted">Der KI-Agent ist geschlossen.</p>
        <button type="button" className="btn" onClick={() => window.dispatchEvent(new CustomEvent('pghl:agent', { detail: {} }))}>
          <Icon name="bot" size={16} /> KI-Agent öffnen
        </button>
      </div>
    </>
  );
}

const PanelBody = memo(function PanelBody({ route, render }: { route: string; render: (parts: string[]) => ReactNode }) {
  const parts = useMemo(() => route.split('/'), [route]);
  if (parts[0] === 'agent')
    return (
      <PageSuspense>
        <EmbeddedAgent />
      </PageSuspense>
    );
  // A panel cannot hold the Arbeitsfläche itself.
  if (parts[0] === 'workspace') return <p className="muted">Diese Seite lässt sich nicht in einem Panel zeigen.</p>;
  return (
    <RouteScope.Provider value={parts}>
      <PageSuspense>{render(parts)}</PageSuspense>
    </RouteScope.Provider>
  );
});

/** The chooser of a panel's page. */
function PagePicker({ current, onPick, onClose }: { current: string; onPick: (route: string) => void; onClose: () => void }) {
  const head = current.split('/')[0];
  return (
    <Modal title="Seite für dieses Panel" onClose={onClose}>
      <div className="ws-pages" role="list">
        {PAGES.map(([route, label]) => (
          <button key={route} type="button" role="listitem" className={`ws-page${route === head ? ' on' : ''}`} onClick={() => (onPick(route), onClose())}>
            <Icon name={(route === 'agent' ? 'bot' : route === 'conversations' ? 'conversations' : route === 'opportunities' ? 'opportunities' : route === 'pm' ? 'gantt' : route === 'dashboard' ? 'dashboard' : route === 'contacts' ? 'contacts' : route === 'boards' ? 'boards' : route === 'calendars' ? 'calendars' : route === 'tasks' ? 'tasks' : route === 'canvas' ? 'canvas' : 'columns3') as any} size={18} />
            <span>{label}</span>
            {route === head && <span className="small muted">aktuell</span>}
          </button>
        ))}
      </div>
    </Modal>
  );
}

function Splitter({ index, sizes, onSizes, rootRef, labels }: { index: number; sizes: number[]; onSizes: (s: number[]) => void; rootRef: { current: HTMLElement | null }; labels: [string, string] }) {
  const drag = useRef<{ x: number; sizes: number[]; width: number } | null>(null);
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, sizes, width: Math.max(1, root.clientWidth - (sizes.length - 1) * 16) };
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) onSizes(resizeBetween(d.sizes, index, (e.clientX - d.x) / d.width));
  };
  const up = () => (drag.current = null);
  const key = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = splitterKey(sizes, index, e.key, e.shiftKey);
    if (!next) return;
    e.preventDefault();
    onSizes(next);
  };
  const pct = Math.round(sizes[index] * 100);
  return (
    <div
      className="ws-split"
      role="separator"
      aria-orientation="vertical"
      aria-label={`Breite: ${labels[0]} und ${labels[1]}`}
      aria-valuenow={pct}
      aria-valuemin={Math.round(XR_LIMITS.minShare * 100)}
      aria-valuemax={Math.round((sizes[index] + sizes[index + 1] - XR_LIMITS.minShare) * 100)}
      tabIndex={0}
      data-tour="ws-splitter"
      title="Ziehen oder mit den Pfeiltasten verschieben (Umschalt: größere Schritte, Doppelklick: gleich breit)"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
      onDoubleClick={() => onSizes(resizeBetween(sizes, index, (sizes[index] + sizes[index + 1]) / 2 - sizes[index]))}
    />
  );
}

export function Workspace({ renderPage }: { renderPage: (route: string[]) => ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const panelsRef = useRef<HTMLDivElement>(null);
  const width = useWidth(root);
  const compact = width > 0 && isCompact(width);
  const [state, setState] = useState<WorkspaceState>(() => {
    const cached = readCache();
    return cached ? fromLayout(cached) : defaultState(3);
  });
  const [loaded, setLoaded] = useState(false);
  const [picker, setPicker] = useState<number | null>(null);
  const [single, setSingle] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const render = useRef(renderPage);
  render.current = renderPage;
  const stableRender = useCallback((parts: string[]) => render.current(parts), []);
  const active = useRef<number | null>(null);
  const saved = useRef('');

  // --- load and save (per person, on the server; the browser copy only makes the first paint quick) ---------------
  useEffect(() => {
    let live = true;
    api
      .get<{ layout: WorkspaceLayout | null }>('/api/xr/workspace')
      .then((r) => {
        if (!live) return;
        if (r.layout) {
          saved.current = JSON.stringify(r.layout);
          setState(fromLayout(r.layout));
        }
      })
      .catch(() => undefined)
      .finally(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, []);
  const layout = useMemo(() => toLayout(state), [state]);
  useEffect(() => {
    if (!loaded) return;
    const sig = JSON.stringify(layout);
    if (sig === saved.current) return;
    const t = setTimeout(() => {
      saved.current = sig;
      writeCache(layout);
      api.put('/api/xr/workspace', { layout }).catch((e) => toastError(e));
    }, 700);
    return () => clearTimeout(t);
  }, [layout, loaded]);

  // --- which panel was touched last: a link made from inside it opens in a panel ---------------------------------
  useEffect(() => {
    const touch = (e: Event) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-ws-panel]') as HTMLElement | null;
      active.current = el ? Number(el.dataset.wsPanel) : null;
    };
    document.addEventListener('pointerdown', touch, true);
    document.addEventListener('focusin', touch, true);
    setNavHook((to) => {
      const from = active.current;
      const parts = toParts(to);
      if (from === null || !parts.length || parts[0] === 'workspace') return false;
      const s = stateRef.current;
      if (from >= s.panels.length) return false;
      const j = targetPanel(
        s.panels.map((p) => p.route),
        from,
        parts,
      );
      setState((cur) => setPanelRoute(cur, j, toRoute(parts)));
      return true;
    });
    // the agent panel reads what the person is looking at from the panel touched last
    contextRoute.override = () => {
      const s = stateRef.current;
      const i = active.current;
      const r = i !== null ? s.panels[i]?.route : undefined;
      return r && r !== 'agent' ? r : (s.panels.find((p) => p.route !== 'agent')?.route ?? null);
    };
    return () => {
      document.removeEventListener('pointerdown', touch, true);
      document.removeEventListener('focusin', touch, true);
      setNavHook(null);
      contextRoute.override = null;
    };
  }, []);

  // --- a pick in one panel updates the contact panel --------------------------------------------------------------
  useEffect(() => subscribeSelection((sel) => setState((cur) => selectContact(cur, sel.contactId) ?? cur)), []);

  const max = width ? maxPanelsFor(width) : XR_LIMITS.workspacePanels;
  const sizes = state.panels.map((p) => p.size);
  const setSizes = (next: number[]) => setState((s) => ({ ...s, panels: s.panels.map((p, i) => ({ ...p, size: next[i] })) }));
  const labels = state.panels.map((p) => routeLabel(p.route));

  const bar = (
    <header className="ws-bar" data-tour="ws-bar">
      <h1>
        <Icon name="columns3" size={22} /> Arbeitsfläche
      </h1>
      {!compact && (
        <div className="ap-seg" role="radiogroup" aria-label="Anzahl Panels" data-tour="ws-count">
          {[2, 3, 4].map((n) => (
            <button key={n} role="radio" aria-checked={state.panels.length === n} className={state.panels.length === n ? 'on' : ''} disabled={n > max} onClick={() => setState((s) => applyCount(s, n))}>
              {n} Panels
            </button>
          ))}
        </div>
      )}
      {!compact && (
        <button type="button" className="btn secondary small" disabled={state.panels.length >= Math.min(max, XR_LIMITS.workspacePanels)} onClick={() => setPicker(-1)} data-tour="ws-add">
          <Icon name="plus" size={15} /> Seite hinzufügen
        </button>
      )}
      <span className="ws-bar-gap" />
      {!compact && (
        <span data-tour="ws-sync" title="Ein Klick im Posteingang oder in der Pipeline zeigt den Kontakt im Kontakt-Panel">
          <Check checked={state.sync} onChange={(v) => setState((s) => ({ ...s, sync: v }))} label="Auswahl verknüpfen" />
        </span>
      )}
      <button type="button" className="btn ghost small" onClick={() => setState(defaultState(Math.min(max, 4)))}>
        <Icon name="reset" size={15} /> Zurücksetzen
      </button>
    </header>
  );

  if (compact) {
    const i = Math.min(single, state.panels.length - 1);
    const p = state.panels[i];
    return (
      <div className="ws ws-compact" ref={root} data-tour="ws-root">
        {bar}
        <p className="ws-note muted small" role="note">
          Die Arbeitsfläche zeigt mehrere Seiten nebeneinander und braucht mindestens {COMPACT_NOTE} Breite – hier siehst du sie einzeln.
        </p>
        <div className="tabs ws-tabs" role="tablist">
          {state.panels.map((q, k) => (
            <button key={q.id} role="tab" aria-selected={k === i} className={k === i ? 'on' : ''} onClick={() => setSingle(k)}>
              {labels[k]}
            </button>
          ))}
        </div>
        <div className="ws-single" data-ws-panel={i}>
          <PanelBody key={p.id} route={p.route} render={stableRender} />
        </div>
      </div>
    );
  }

  const style = (p: { size: number }) => ({ flex: `${p.size} 1 0` }) as CSSProperties;
  return (
    <div className="ws" ref={root} data-tour="ws-root">
      {bar}
      <div className="ws-panels" ref={panelsRef} data-tour="ws-panels" data-count={state.panels.length}>
        {state.panels.map((p, i) => (
          <div key={p.id} className="ws-slot" style={{ display: 'contents' }}>
            <section className="ws-panel" style={style(p)} data-ws-panel={i} aria-label={labels[i]}>
              <header className="ws-head">
                <button type="button" className="ws-title" onClick={() => setPicker(i)} aria-label={`${labels[i]}: Seite wählen`} data-tour="ws-title">
                  <span>{labels[i]}</span>
                  <ChevronDown size={15} />
                </button>
                <span className="ws-head-gap" />
                <button type="button" className="icon-btn" disabled={i === 0} onClick={() => setState((s) => movePanel(s, i, -1))} aria-label={`${labels[i]} nach links`} title="Nach links">
                  <ChevronLeft size={16} />
                </button>
                <button type="button" className="icon-btn" disabled={i === state.panels.length - 1} onClick={() => setState((s) => movePanel(s, i, 1))} aria-label={`${labels[i]} nach rechts`} title="Nach rechts">
                  <ChevronRight size={16} />
                </button>
                <button type="button" className="icon-btn" onClick={() => p.route !== 'agent' && navigate(p.route)} disabled={p.route === 'agent'} aria-label={`${labels[i]} im Hauptfenster öffnen`} title="Im Hauptfenster öffnen">
                  <Icon name="external" size={16} />
                </button>
                <button type="button" className="icon-btn" disabled={state.panels.length <= 1} onClick={() => setState((s) => removePanel(s, i))} aria-label={`${labels[i]} schließen`} title="Panel schließen">
                  ✕
                </button>
              </header>
              <div className="ws-body">
                <PanelBody route={p.route} render={stableRender} />
              </div>
            </section>
            {i < state.panels.length - 1 && <Splitter index={i} sizes={sizes} onSizes={setSizes} rootRef={panelsRef} labels={[labels[i], labels[i + 1]]} />}
          </div>
        ))}
      </div>
      {picker !== null && (
        <PagePicker
          current={picker >= 0 ? state.panels[picker].route : ''}
          onPick={(route) => setState((s) => (picker >= 0 ? setPanelRoute(s, picker, route) : addPanel(s, route)))}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

const COMPACT_NOTE = '1000 px';
