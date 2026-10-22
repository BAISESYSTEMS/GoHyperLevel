import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { useSession } from '../session';
import { Check, Modal, Spinner, navigate, toastError } from '../ui';
import { ACTOR_BADGE, FILTER_TYPES, dayLabel, entityIcon, requestUndo, say, timeLabel, type UndoChange, type UndoConflict, type UndoEntry, type UndoneInfo } from './shared';
import './undo.css';
import { useT } from '../i18n';

/**
 * "Rückgängig" everywhere (docs/undo.md):
 * - a toast after every journaled change ("Aufgabe „…“ erledigt · Rückgängig"), 8 s, paused while the pointer or focus is on it;
 * - Strg/⌘+Z takes my last change back (not while typing in a field), Strg+Shift+Z / Strg+Y repeats it;
 * - the conflict dialog when the record changed since (diff, then "Trotzdem wiederherstellen" or "Abbrechen");
 * - the "Verlauf" panel: my last changes by day, with search, type filter and a restore button each.
 * The api wrapper announces every change as `pghl:undo-entry`; undo results come as `pghl:undone`.
 */

const SHOW_MS = 8000;
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Strg';

interface ToastItem {
  key: string;
  /** The entry the "Rückgängig" button takes back. */
  entryId?: string;
  text: string;
  notice?: string;
  tone: 'change' | 'undone';
}

/** Typing somewhere the browser has its own undo: leave Strg+Z to it. */
function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable || el.closest?.('.cm-editor, [role="textbox"], .ProseMirror')) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName === 'INPUT') return !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes((el as HTMLInputElement).type);
  return false;
}

function ToastView({ t: item, onClose, onUndo }: { t: ToastItem; onClose: () => void; onUndo: () => void }) {
  // The toast's own words are translated (shell catalog); the change it names comes from the server and stays German.
  const t = useT('shell');
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const held = hover || focus;
  const left = useRef(SHOW_MS);
  const started = useRef(0);
  // The countdown stops while the pointer or the keyboard focus is on the toast and goes on where it left off.
  useEffect(() => {
    if (held) {
      left.current -= Date.now() - started.current;
      return;
    }
    started.current = Date.now();
    const id = window.setTimeout(onClose, Math.max(400, left.current));
    return () => window.clearTimeout(id);
  }, [held]);
  return (
    <div
      className={`undo-toast ${item.tone}`}
      role="group"
      aria-label={item.tone === 'undone' ? t('Rückgängig gemacht') : t('Änderung')}
      data-tour="undo-toast"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocus(false)}
    >
      <div className="undo-toast-main">
        <Icon name={item.tone === 'undone' ? 'undo' : 'ok'} size={18} />
        <span className="undo-toast-text">{item.text}</span>
        {item.entryId && (
          <button type="button" className="undo-btn" onClick={onUndo} aria-label={`${item.tone === 'undone' ? t('Wiederholen') : t('Rückgängig')}: ${item.text}`}>
            {item.tone === 'undone' ? t('Wiederholen') : t('Rückgängig')}
          </button>
        )}
        <button type="button" className="undo-x" onClick={onClose} aria-label={t('Hinweis schließen')}>
          ✕
        </button>
      </div>
      {item.notice && <p className="undo-toast-notice">{item.notice}</p>}
      <span className="undo-bar" style={{ animationDuration: `${SHOW_MS}ms`, animationPlayState: held ? 'paused' : 'running' }} aria-hidden="true" />
    </div>
  );
}

function ConflictDialog({ c, onClose }: { c: UndoConflict; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  // It can open on top of the Verlauf: Esc closes only this dialog, not the panel under it.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  return (
    <Modal
      title="Seitdem geändert"
      onClose={onClose}
      wide
      className="undo-modal"
      footer={
        <>
          <button className="btn secondary undo-big" onClick={onClose} data-tour="undo-conflict-cancel">
            Abbrechen
          </button>
          <button
            className="btn undo-big"
            disabled={busy}
            data-tour="undo-conflict-force"
            onClick={async () => {
              setBusy(true);
              const ok = await requestUndo({ id: c.id, label: c.label }, { force: true, single: c.single });
              setBusy(false);
              if (ok) onClose();
            }}
          >
            Trotzdem wiederherstellen
          </button>
        </>
      }
    >
      <p>{c.message}</p>
      {c.notice && <p className="undo-notice">{c.notice}</p>}
      <div className="undo-diff-wrap">
        <table className="undo-diff">
          <thead>
            <tr>
              <th>Feld</th>
              <th>Nach der Änderung</th>
              <th>Jetzt</th>
              <th>Nach dem Wiederherstellen</th>
            </tr>
          </thead>
          <tbody>
            {c.diff.map((d, i) => (
              <tr key={`${d.field}${i}`}>
                <th scope="row">{d.label}</th>
                <td>{d.entry}</td>
                <td className="now">{d.now}</td>
                <td className="restore">{d.restore}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">„Trotzdem wiederherstellen“ überschreibt die neueren Werte mit denen aus der rechten Spalte.</p>
    </Modal>
  );
}

function Changes({ changes }: { changes: UndoChange[] }) {
  if (!changes.length) return null;
  return (
    <ul className="undo-changes">
      {changes.map((c, i) => (
        <li key={`${c.k}${i}`}>
          <span className="k">{c.l}</span>
          <span className="from">{c.from}</span>
          <span className="arrow" aria-label="geändert zu">
            →
          </span>
          <span className="to">{c.to}</span>
        </li>
      ))}
    </ul>
  );
}

function Row({ e, onDone }: { e: UndoEntry; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const badge = ACTOR_BADGE[e.actor_kind];
  const verb = e.is_redo ? 'Wiederholen' : 'Wiederherstellen';
  return (
    <li className={`undo-row${e.undone_at ? ' undone' : ''}`} data-tour="history-entry">
      <span className="undo-ico">
        <Icon name={e.kind === 'undo' ? 'undo' : entityIcon(e.entity)} size={18} />
      </span>
      <div className="undo-row-body">
        <div className="undo-row-title">{e.label}</div>
        <div className="undo-row-meta muted small">
          {timeLabel(e.at)} · {e.mine ? 'du' : e.actor}
          {badge && <span className="undo-badge">{badge}</span>}
          {e.count > 1 && <span className="undo-badge">{e.count} Einträge</span>}
          {e.undone_at && <span className="undo-badge gray">rückgängig gemacht</span>}
        </div>
        <Changes changes={e.changes} />
        {e.notice && <p className="undo-notice">{e.notice}</p>}
        {!e.restorable && e.reason && <p className="muted small">{e.reason}</p>}
      </div>
      {!e.undone_at && e.restorable && (
        <div className="undo-row-act">
          {e.can_undo ? (
            <button
              className="btn undo-big"
              disabled={busy}
              data-tour="history-restore"
              aria-label={`${verb}: ${e.label}`}
              onClick={async () => {
                setBusy(true);
                await requestUndo(e);
                setBusy(false);
                onDone();
              }}
            >
              {verb}
            </button>
          ) : (
            <span className="muted small undo-why">{e.mine ? 'nicht mehr möglich' : `nur ${e.actor} oder ein Admin`}</span>
          )}
        </div>
      )}
    </li>
  );
}

function HistoryPanel({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const admin = session.user.role === 'admin';
  const [q, setQ] = useState('');
  const [entity, setEntity] = useState('');
  const [all, setAll] = useState(false);
  const [showUndone, setShowUndone] = useState(false);
  const [items, setItems] = useState<UndoEntry[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);
  const seq = useRef(0);

  const load = useCallback(
    async (append = false) => {
      const my = ++seq.current;
      setLoading(true);
      const p = new URLSearchParams({ limit: '40', scope: all ? 'all' : 'mine' });
      if (q.trim()) p.set('q', q.trim());
      if (entity) p.set('entity', entity);
      if (showUndone) p.set('include', 'undone');
      if (append && items.length) p.set('before', items[items.length - 1].at);
      try {
        const r = await api.get<{ items: UndoEntry[]; has_more: boolean; retention_days: number }>(`/api/undo?${p}`);
        if (my !== seq.current) return;
        setItems((cur) => (append ? [...cur, ...r.items] : r.items));
        setMore(r.has_more);
        setDays(r.retention_days);
      } catch (e) {
        toastError(e);
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    [q, entity, all, showUndone, items],
  );
  // Typing in the search waits a moment; the filters apply at once.
  useEffect(() => {
    const t = window.setTimeout(() => void load(false), q ? 250 : 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, entity, all, showUndone]);
  useEffect(() => {
    const on = () => void load(false);
    window.addEventListener('pghl:undone', on);
    return () => window.removeEventListener('pghl:undone', on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, entity, all, showUndone]);

  const groups = useMemo(() => {
    const out: { day: string; rows: UndoEntry[] }[] = [];
    for (const e of items) {
      const day = dayLabel(e.at);
      const g = out[out.length - 1];
      if (g?.day === day) g.rows.push(e);
      else out.push({ day, rows: [e] });
    }
    return out;
  }, [items]);

  return (
    <Modal title="Verlauf" onClose={onClose} wide className="undo-modal undo-history" footer={<span className="muted small">Änderungen bleiben {days} Tage im Verlauf. {isMac ? '⌘' : 'Strg'}+Z macht die letzte rückgängig.</span>}>
      <div className="undo-filters" data-tour="history-filters">
        <input type="search" className="undo-search" placeholder="Suchen: Aufgabe, Kontakt, Deal …" aria-label="Im Verlauf suchen" value={q} onChange={(e) => setQ(e.target.value)} autoFocus data-tour="history-search" />
        <select value={entity} onChange={(e) => setEntity(e.target.value)} aria-label="Nach Art filtern" data-tour="history-type">
          <option value="">Alle Arten</option>
          {FILTER_TYPES.map(([k, n]) => (
            <option key={k} value={k}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <div className="undo-toggles">
        {admin && <Check checked={all} onChange={setAll} label="Alle Änderungen im Sub-Account" />}
        <Check checked={showUndone} onChange={setShowUndone} label="Auch Zurückgenommenes zeigen" />
      </div>
      {loading && !items.length ? (
        <Spinner />
      ) : groups.length ? (
        <div className="undo-list" data-tour="history-list">
          {groups.map((g) => (
            <section key={g.day} aria-label={g.day}>
              <h4 className="undo-day">{g.day}</h4>
              <ul>
                {g.rows.map((e) => (
                  <Row key={e.id} e={e} onDone={() => void load(false)} />
                ))}
              </ul>
            </section>
          ))}
          {more && (
            <button className="btn secondary undo-big" onClick={() => void load(true)} disabled={loading}>
              Ältere zeigen
            </button>
          )}
        </div>
      ) : (
        <div className="undo-empty">
          <Icon name="history" size={28} />
          <p>{q || entity ? 'Dazu gibt es nichts im Verlauf.' : 'Noch nichts geändert – hier erscheint jede Änderung, die du machst, mit „Wiederherstellen“.'}</p>
        </div>
      )}
      <p className="undo-link-row">
        <a
          href="/app/trash"
          onClick={(e) => {
            e.preventDefault();
            onClose();
            navigate('trash');
          }}
        >
          <Icon name="trash" size={14} /> Zum Papierkorb (gelöschte Datensätze)
        </a>
      </p>
    </Modal>
  );
}

/** The top bar's entry to the history – opens the panel in UndoLayer. */
export function HistoryButton() {
  const t = useT('shell');
  return (
    <button className="btn secondary small undo-top-btn" data-tour="history-button" onClick={() => window.dispatchEvent(new Event('pghl:verlauf'))} title={t('Verlauf – meine letzten Änderungen ({key}+Z macht die letzte rückgängig)', { key: t(MOD) })} aria-label={t('Verlauf öffnen')}>
      <Icon name="history" size={16} /> <span className="undo-top-label">{t('Verlauf')}</span>
    </button>
  );
}

export function UndoLayer(): ReactNode {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [conflict, setConflict] = useState<UndoConflict | null>(null);
  const [panel, setPanel] = useState(false);
  const [live, setLive] = useState('');
  const n = useRef(0);

  const push = useCallback((t: Omit<ToastItem, 'key'>) => {
    const key = `u${++n.current}`;
    setToasts((l) => [...l.filter((x) => !(t.entryId && x.entryId === t.entryId)), { ...t, key }].slice(-3));
  }, []);
  const drop = useCallback((key: string) => setToasts((l) => l.filter((x) => x.key !== key)), []);

  useEffect(() => {
    const onEntry = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; label: string; notice?: string }>).detail;
      push({ entryId: d.id, text: d.label, notice: d.notice || undefined, tone: 'change' });
      setLive(`${d.label}. ${MOD}+Z macht das rückgängig.${d.notice ? ` ${d.notice}` : ''}`);
    };
    const onUndone = (e: Event) => {
      const d = (e as CustomEvent<UndoneInfo>).detail;
      push({ entryId: d.redo_id ?? undefined, text: d.label, notice: d.notices?.[0], tone: 'undone' });
      setLive(`Rückgängig gemacht: ${d.label}.${d.notices?.[0] ? ` ${d.notices[0]}` : ''}`);
    };
    const onConflict = (e: Event) => setConflict((e as CustomEvent<UndoConflict>).detail);
    const onSay = (e: Event) => setLive(String((e as CustomEvent<string>).detail));
    const onPanel = () => setPanel(true);
    // The agent's card: "Rückgängig" for what it changed.
    const onDo = (e: Event) => void requestUndo({ id: String((e as CustomEvent<{ id: string }>).detail.id) });
    window.addEventListener('pghl:undo-entry', onEntry);
    window.addEventListener('pghl:undone', onUndone);
    window.addEventListener('pghl:undo-conflict', onConflict);
    window.addEventListener('pghl:announce', onSay);
    window.addEventListener('pghl:verlauf', onPanel);
    window.addEventListener('pghl:undo-do', onDo);
    return () => {
      window.removeEventListener('pghl:undo-entry', onEntry);
      window.removeEventListener('pghl:undone', onUndone);
      window.removeEventListener('pghl:undo-conflict', onConflict);
      window.removeEventListener('pghl:announce', onSay);
      window.removeEventListener('pghl:verlauf', onPanel);
      window.removeEventListener('pghl:undo-do', onDo);
    };
  }, [push]);

  // Strg/⌘+Z: my last change; Strg+Shift+Z or Strg+Y: the undo again. Never while typing (the field has its own undo) or in the canvas editor.
  useEffect(() => {
    let busy = false;
    const onKey = async (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || !(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      const redo = (k === 'z' && e.shiftKey) || (k === 'y' && !isMac);
      if (!redo && !(k === 'z' && !e.shiftKey)) return;
      if (typing(e.target) || location.pathname.startsWith('/app/canvas') || document.querySelector('.modal-bg')) return;
      e.preventDefault();
      if (busy) return;
      busy = true;
      try {
        const last = await api.get<{ undo: UndoEntry | null; redo: UndoEntry | null }>('/api/undo/last');
        const entry = redo ? last.redo : last.undo;
        if (!entry) {
          const msg = redo ? 'Nichts zu wiederholen.' : 'Nichts zum Rückgängigmachen.';
          push({ text: msg, tone: 'undone' });
          say(msg);
        } else await requestUndo(entry);
      } catch (err) {
        toastError(err);
      } finally {
        busy = false;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [push]);

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {live}
      </div>
      {toasts.length > 0 && (
        <div className="undo-toasts" data-tour="undo-toasts">
          {toasts.map((t) => (
            <ToastView
              key={t.key}
              t={t}
              onClose={() => drop(t.key)}
              onUndo={async () => {
                drop(t.key);
                if (t.entryId) await requestUndo({ id: t.entryId, label: t.text });
              }}
            />
          ))}
        </div>
      )}
      {panel && <HistoryPanel onClose={() => setPanel(false)} />}
      {conflict && <ConflictDialog c={conflict} onClose={() => setConflict(null)} />}
    </>
  );
}

