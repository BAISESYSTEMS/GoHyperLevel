import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type CSSProperties } from 'react';
import { DEFAULT_LIMITS, bpFor, limitsAt, type Limits } from '../../../server/services/boards-layout';
import { api } from '../api';
import { Icon, type IconName } from '../icons';
import { useSession } from '../session';
import { Empty, Link, Spinner, toastError } from '../ui';
import { Grid } from './Grid';
import { forgetHome, rememberHome } from './home';
import { History } from './History';
import { Picker } from './Picker';
import { BoardSettings } from './BoardSettings';
import { PromptBar } from './PromptBar';
import { SettingsPanel } from './Settings';
import { useBoard, useCatalogue, useWidgetData } from './store';
import { WidgetCard } from './WidgetCard';
import { arrange, cellsOf, sameCells, withCells } from './layout';
import { MoveMenu } from '../xr/MoveMenu';
import { XrButton } from '../xr/XrButton';
import type { Widget, WidgetType } from './types';

const BP_NAME = { lg: 'Desktop', md: 'Tablet', sm: 'Handy' } as const;
const WIDGET_MOVES = [
  { id: 'top', label: 'Ganz nach oben' },
  { id: 'up', label: 'Eine Zeile höher' },
  { id: 'down', label: 'Eine Zeile tiefer' },
  { id: 'left', label: 'Nach links' },
  { id: 'right', label: 'Nach rechts' },
  { id: 'wider', label: 'Breiter', hint: 'eine Spalte mehr' },
  { id: 'narrower', label: 'Schmaler', hint: 'eine Spalte weniger' },
  { id: 'taller', label: 'Höher', hint: 'eine Zeile mehr' },
  { id: 'shorter', label: 'Niedriger', hint: 'eine Zeile weniger' },
];
const WISHES = ['Zeig mir meine Pipeline und die Aufgaben von heute', 'Ein Diagramm mit dem Umsatz der letzten 90 Tage', 'Die letzten Gespräche und der Kalender nebeneinander'];

/** Does a freshly added widget need a choice before it shows anything (a page, an address, buttons …)? Then its settings open at once. */
const needsSetup = (t: WidgetType) => t.fields.some((f) => !f.hidden && !f.default && (f.optionsFrom || f.type === 'url' || f.type === 'textarea' || f.type === 'list'));

/** The width of the canvas, also when it only appears after the board has loaded (a callback ref, not a ref object). */
function useBoxWidth(): [(el: HTMLDivElement | null) => void, number] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, w];
}

const initials = (n: string) =>
  n
    .split(/\s+/)
    .map((x) => x[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

/** One board: the grid with its widgets, the editor around it, the prompt bar below. */
export function BoardView({ id }: { id: string }) {
  const session = useSession();
  const { board, setBoard, error, viewers, live, online, reload, patch, call, undo, redo, restore } = useBoard(id);
  const catalogue = useCatalogue();
  const { data, loading, refresh } = useWidgetData(id, board?.spec);
  const [ref, width] = useBoxWidth();
  const [edit, setEdit] = useState(false);
  const [picker, setPicker] = useState(false);
  const [settings, setSettings] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [cfg, setCfg] = useState(false);
  const [autoApply, setAutoApply] = useState('layout');
  const [fresh, setFresh] = useState<string | null>(null);
  const [snack, setSnack] = useState<{ text: string; n: number } | null>(null);
  const [wish, setWish] = useState<{ text: string; n: number } | undefined>();
  const bp = width ? bpFor(width) : 'lg';
  const canEdit = !!board && board.access !== 'view';
  const types = useMemo(() => new Map((catalogue?.widgets ?? []).map((t) => [t.type, t])), [catalogue]);

  useEffect(() => {
    api.get<{ auto_apply: string }>('/api/boards/prefs').then((p) => setAutoApply(p.auto_apply)).catch(() => undefined);
  }, []);
  useEffect(() => {
    setEdit(false);
    setSettings(null);
    const w = new URLSearchParams(location.search).get('wish');
    if (w) {
      setWish({ text: w.slice(0, 1000), n: Date.now() });
      history.replaceState(null, '', location.pathname);
    }
  }, [id]);
  useEffect(() => {
    if (!canEdit) setEdit(false);
  }, [canEdit]);
  useEffect(() => {
    if (error) forgetHome(id);
  }, [error, id]);
  useEffect(() => {
    if (!snack) return;
    const t = setTimeout(() => setSnack((s) => (s === snack ? null : s)), 7000);
    return () => clearTimeout(t);
  }, [snack]);
  useEffect(() => {
    if (!fresh) return;
    const t = setTimeout(() => setFresh(null), 2600);
    return () => clearTimeout(t);
  }, [fresh]);

  // Strg+Z / Strg+Umschalt+Z outside of text fields
  useEffect(() => {
    if (!canEdit) return;
    const k = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || (e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      void (e.shiftKey ? redo() : undo());
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [canEdit, undo, redo]);

  const limits = useCallback(
    (type: string): Limits => {
      const s = types.get(type)?.size;
      return s ? { minW: s.minW, minH: s.minH, maxW: s.maxW, maxH: s.maxH } : DEFAULT_LIMITS;
    },
    [types],
  );
  const titleOf = useCallback((w: Widget) => w.title || types.get(w.type)?.label || 'Widget', [types]);

  const commit = useCallback(
    (ops: Record<string, unknown>[], cells: Parameters<typeof withCells>[2]) => {
      void patch(ops, (b) => ({ ...b, spec: withCells(b.spec, bp, cells) }));
    },
    [patch, bp],
  );

  /** Raum-Modus: "Verschieben nach …" – the same moves as the grip, as buttons (no steady hand needed). */
  const nudge = useCallback(
    (w: Widget, action: string) => {
      if (!board) return;
      const cells = cellsOf(board.spec.widgets, bp);
      const me = cells.find((c) => c.id === w.id);
      if (!me) return;
      const lim = limitsAt(limits(w.type), bp);
      const to = (cur: typeof me) => arrange(cells, w.id, cur, me, bp, lim);
      let next = cells;
      if (action === 'top') next = to({ ...me, y: 0 });
      else if (action === 'left') next = to({ ...me, x: me.x - 1 });
      else if (action === 'right') next = to({ ...me, x: me.x + 1 });
      else if (action === 'up' || action === 'down') {
        // up and down jump to the next place where the card really lands differently (it cannot rest below free space)
        const dir = action === 'up' ? -1 : 1;
        for (let k = 1; k <= me.h + 2 && next === cells; k++) {
          const tried = to({ ...me, y: Math.max(0, me.y + dir * k) });
          if (!sameCells(tried, cells)) next = tried;
        }
      } else if (action === 'wider') next = to({ ...me, w: me.w + 1 });
      else if (action === 'narrower') next = to({ ...me, w: me.w - 1 });
      else if (action === 'taller') next = to({ ...me, h: me.h + 1 });
      else if (action === 'shorter') next = to({ ...me, h: me.h - 1 });
      const after = next.find((c) => c.id === w.id);
      if (!after || sameCells(next, cells)) return;
      const ops: Record<string, unknown>[] = [];
      if (after.x !== me.x || after.y !== me.y) ops.push({ op: 'move', id: w.id, x: after.x, y: after.y, bp });
      if (after.w !== me.w || after.h !== me.h) ops.push({ op: 'resize', id: w.id, w: after.w, h: after.h, bp });
      if (ops.length) commit(ops, next);
    },
    [board, bp, limits, commit],
  );

  const add = async (t: WidgetType) => {
    if (!board) return;
    setPicker(false);
    const before = new Set(board.spec.widgets.map((w) => w.id));
    const next = await patch([{ op: 'add', type: t.type, placement: 'bottom' }]);
    const made = next?.spec.widgets.find((w) => !before.has(w.id));
    if (!made) return;
    setFresh(made.id);
    setTimeout(() => document.querySelector(`[data-widget="${made.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }), 120);
    if (needsSetup(t)) setSettings(made.id);
  };
  const remove = async (w: Widget) => {
    setSettings(null);
    const next = await patch([{ op: 'remove', id: w.id }], (b) => ({ ...b, spec: { ...b.spec, widgets: b.spec.widgets.filter((x) => x.id !== w.id) } }));
    if (next) setSnack({ text: `„${titleOf(w)}“ entfernt`, n: Date.now() });
  };
  const toggleHome = async (on: boolean) => {
    try {
      const r = await api.put<{ home: { board_id: string; location_id: string } | null }>('/api/boards/home', { board_id: on ? id : null });
      rememberHome(r.home);
      setBoard((b) => (b ? { ...b, home: on } : b));
      window.dispatchEvent(new Event('pghl:boards'));
    } catch (e) {
      toastError(e);
    }
  };
  const setApply = async (v: string) => {
    setAutoApply(v);
    try {
      await api.put('/api/boards/prefs', { auto_apply: v });
    } catch (e) {
      toastError(e);
    }
  };

  if (error)
    return (
      <Empty action={<Link to="boards" className="btn secondary">Zu allen Boards</Link>}>
        {error}
      </Empty>
    );
  if (!board)
    return (
      <div className="bd-page">
        <Spinner />
      </div>
    );

  const others = viewers.filter((v) => v.user_id !== session.user.id);
  const sel = board.spec.widgets.find((w) => w.id === settings);
  const empty = board.spec.widgets.length === 0;
  const custom = bp !== 'lg' && !!board.spec.custom?.[bp];
  const style = (board.accent ? { '--bd-accent': board.accent } : undefined) as CSSProperties | undefined;

  return (
    <div className={`bd-page${edit ? ' editing' : ''}`} style={style} data-tour="board-page">
      <header className="bd-head">
        <Link to="boards" className="bd-back">
          <Icon name="boards" size={14} /> Boards
        </Link>
        <div className="bd-title">
          <span className="bd-title-icon">
            <Icon name={(board.icon || 'boards') as IconName} size={20} />
          </span>
          <h1>{board.name}</h1>
          <span className={`bd-badge${board.scope === 'shared' ? ' tone-blue' : ''}`} title={board.scope === 'shared' ? 'Das Team sieht dieses Board' : 'Nur du siehst dieses Board'}>
            {board.scope === 'shared' ? 'Team' : 'Persönlich'}
          </span>
          {board.home && (
            <span className="bd-badge tone-green" title="Deine Startseite">
              <Icon name="house" size={12} /> Startseite
            </span>
          )}
          {!canEdit && (
            <span className="bd-badge" title="Du darfst dieses Board ansehen, aber nicht ändern">
              <Icon name="lock" size={12} /> Nur Ansicht
            </span>
          )}
        </div>
        <div className="bd-tools">
          {others.length > 0 && (
            <span className="bd-viewers" title={`${others.map((v) => v.name).join(', ')} ${others.length === 1 ? 'sieht' : 'sehen'} gerade zu`}>
              {others.slice(0, 4).map((v, i) => (
                <i key={`${v.user_id}${i}`}>{initials(v.name)}</i>
              ))}
              {others.length > 4 && <i>+{others.length - 4}</i>}
            </span>
          )}
          {!online && <span className="bd-badge tone-yellow">Verbindung wird neu aufgebaut …</span>}
          {canEdit && (
            <>
              <button type="button" className="bd-iconbtn lg" onClick={() => void undo()} disabled={!board.can_undo} aria-label="Rückgängig (Strg+Z)" title="Rückgängig (Strg+Z)">
                <Icon name="undo" size={16} />
              </button>
              <button type="button" className="bd-iconbtn lg" onClick={() => void redo()} disabled={!board.can_redo} aria-label="Wiederholen (Strg+Umschalt+Z)" title="Wiederholen (Strg+Umschalt+Z)">
                <Icon name="redo" size={16} />
              </button>
            </>
          )}
          <XrButton kind="board" id={id} name={board.name} />
          <button type="button" className="btn secondary small" onClick={() => setShowHistory(true)} data-tour="board-history-btn">
            <Icon name="history" size={14} /> Verlauf
          </button>
          <button type="button" className="btn secondary small" onClick={() => setCfg(true)} aria-label="Board-Einstellungen" data-tour="board-config">
            <Icon name="settings" size={14} /> <span className="bd-hide-s">Einstellungen</span>
          </button>
          {canEdit && (
            <button type="button" className={`btn small${edit ? '' : ' secondary'}`} onClick={() => setEdit(!edit)} aria-pressed={edit} data-tour="board-edit">
              <Icon name={edit ? 'check' : 'edit'} size={14} /> {edit ? 'Fertig' : 'Anpassen'}
            </button>
          )}
        </div>
      </header>

      {live && (
        <p className="bd-live" role="status">
          <Icon name="sparkles" size={14} />
          <span>
            <b>{live.actor}</b> {live.via === 'agent' ? '(KI) ' : ''}hat das Board geändert: {live.summary}
          </span>
        </p>
      )}

      {edit && (
        <div className="bd-editbar" data-tour="board-editbar">
          <button type="button" className="btn small" onClick={() => setPicker(true)} data-tour="board-add">
            <Icon name="plus" size={14} /> Widget hinzufügen
          </button>
          <span className="muted small bd-editbar-tip">
            {bp === 'sm' ? 'Mit den Pfeilen sortierst du die Widgets.' : 'Am Griff ziehen, an der Ecke unten rechts die Größe ändern. Tastatur: Griff wählen, Leertaste, Pfeile (Umschalt = Größe), Leertaste.'} Du bearbeitest die Ansicht „{BP_NAME[bp]}“.
          </span>
          {custom && (
            <button
              type="button"
              className="btn ghost small"
              onClick={async () => {
                try {
                  setBoard(await api.post(`/api/boards/${id}/reset-layout`, { bp }));
                } catch (e) {
                  toastError(e);
                }
              }}
              title="Die Anordnung wieder aus der Desktop-Ansicht ableiten"
            >
              <Icon name="reset" size={14} /> {BP_NAME[bp]}-Anordnung zurücksetzen
            </button>
          )}
        </div>
      )}

      {/* Live-Zusammenarbeit: other people's cursors are placed relative to this grid (presence/client.ts) */}
      <div ref={ref} className="bd-canvas" data-presence-surface="board">
        {empty ? (
          <div className="bd-empty" data-tour="board-empty">
            <Icon name="boards" size={30} />
            <h2>Dieses Board ist noch leer</h2>
            <p className="muted">Füge Widgets hinzu – oder sag dem Board unten, was du sehen willst.</p>
            {canEdit && (
              <div className="bd-empty-actions">
                <button type="button" className="btn" onClick={() => (setEdit(true), setPicker(true))}>
                  <Icon name="plus" size={15} /> Widget hinzufügen
                </button>
                <Link to="boards/vorlagen" className="btn secondary">
                  <Icon name="template" size={15} /> Vorlagen ansehen
                </Link>
              </div>
            )}
            {canEdit && (
              <div className="chips bd-wishes">
                {WISHES.map((w) => (
                  <button key={w} type="button" className="chip" onClick={() => setWish({ text: w, n: Date.now() })}>
                    „{w}“
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <Grid
            widgets={board.spec.widgets}
            bp={bp}
            width={width}
            edit={edit}
            limits={limits}
            titleOf={titleOf}
            onCommit={commit}
            render={(w, part) => <WidgetCard w={w} type={types.get(w.type)} data={data[w.id]} loading={loading} part={part} edit={edit} selected={settings === w.id} fresh={fresh === w.id} onSettings={() => setSettings(w.id)} onRemove={() => void remove(w)} onRefresh={() => void refresh([w.id])} moveMenu={bp !== 'sm' ? <MoveMenu what={`Widget „${titleOf(w)}“`} title="Widget verschieben oder anpassen" targets={WIDGET_MOVES} onMove={(a) => nudge(w, a)} /> : undefined} />}
          />
        )}
      </div>

      {snack && (
        <div className="bd-snack" role="status">
          <span>{snack.text}</span>
          <button
            type="button"
            className="btn ghost small"
            onClick={async () => {
              setSnack(null);
              await undo();
            }}
          >
            <Icon name="undo" size={14} /> Rückgängig
          </button>
        </div>
      )}

      <PromptBar board={board} catalogue={catalogue} call={call} onUndo={undo} canEdit={canEdit} wish={wish} />

      {picker && catalogue && <Picker catalogue={catalogue} full={board.spec.widgets.length >= catalogue.limits.widgets} onPick={(t) => void add(t)} onClose={() => setPicker(false)} />}
      {sel && (
        <SettingsPanel
          key={sel.id}
          widget={sel}
          type={types.get(sel.type)}
          canEdit={canEdit}
          onClose={() => setSettings(null)}
          onRemove={() => void remove(sel)}
          onSave={async ({ config, title }) => {
            const ops: Record<string, unknown>[] = [];
            if (Object.keys(config).length || title !== sel.title) ops.push({ op: 'configure', id: sel.id, ...(Object.keys(config).length ? { config } : {}), title });
            if (!ops.length) return true;
            return !!(await patch(ops));
          }}
        />
      )}
      {showHistory && <History board={board} catalogue={catalogue} canEdit={canEdit} onRestore={restore} onClose={() => setShowHistory(false)} />}
      {cfg && <BoardSettings board={board} admin={session.user.role === 'admin'} home={board.home} autoApply={autoApply} onPatch={(ops) => patch(ops)} onReload={reload} onHome={(v) => void toggleHome(v)} onAutoApply={(v) => void setApply(v)} onClose={() => setCfg(false)} />}
    </div>
  );
}

