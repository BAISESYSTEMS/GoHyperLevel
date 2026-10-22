import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { amount, api } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { TagChips } from '../tag-chip';
import { act, Badge, Modal, pressable } from '../ui';
import { MoveMenu } from '../xr/MoveMenu';
import { publishSelection } from '../xr/selection';
import { closeInfo, LOST_TEXT, sums } from './deal-kit';
import './deals.css';
import { DealSmartChips } from './DealSmartTags';

/**
 * The pipeline board (Kanban) with the comfort of HighLevel: coloured stage headers (dot + top border) with the number of deals
 * and their value, stages that fold to a narrow strip, columns you can make wider or narrower – folded stages and widths are
 * remembered per person and pipeline in this browser – and the dialog that sorts the pipelines by drag & drop.
 */

const MIN_W = 220;
const MAX_W = 560;
const DEF_W = 270;
interface BoardPrefs {
  collapsed: string[];
  widths: Record<string, number>;
}
const clampW = (w: number) => Math.max(MIN_W, Math.min(MAX_W, Math.round(w)));

function loadPrefs(key: string): BoardPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null');
    const widths: Record<string, number> = {};
    for (const [k, w] of Object.entries(v?.widths ?? {})) if (typeof w === 'number' && Number.isFinite(w)) widths[k] = clampW(w);
    return { collapsed: Array.isArray(v?.collapsed) ? v.collapsed.filter((x: unknown) => typeof x === 'string') : [], widths };
  } catch {
    return { collapsed: [], widths: {} };
  }
}
function savePrefs(key: string, p: BoardPrefs) {
  try {
    localStorage.setItem(key, JSON.stringify(p));
  } catch {
    // private window or blocked storage: the board still works, it only forgets
  }
}

export function DealBoard({ pipeline, list, onOpen, onMove }: { pipeline: any; list: any[]; onOpen: (o: any) => void; onMove: (stageId: string, oppId: string) => void }) {
  const t = useT('deals');
  const session = useSession();
  const key = `pghl.board.${session.user?.id ?? ''}.${pipeline.id}`;
  const [prefs, setPrefsState] = useState<BoardPrefs>(() => loadPrefs(key));
  const [over, setOver] = useState('');
  useEffect(() => setPrefsState(loadPrefs(key)), [key]);
  const setPrefs = (p: BoardPrefs) => {
    setPrefsState(p);
    savePrefs(key, p);
  };
  const toggle = (sid: string) => setPrefs({ ...prefs, collapsed: prefs.collapsed.includes(sid) ? prefs.collapsed.filter((x) => x !== sid) : [...prefs.collapsed, sid] });
  const setWidth = (sid: string, w: number | null, save = true) => {
    const widths = { ...prefs.widths };
    if (w === null) delete widths[sid];
    else widths[sid] = clampW(w);
    (save ? setPrefs : setPrefsState)({ ...prefs, widths });
  };
  return (
    <div className="kanban deal-board" data-tour="opps-board">
      {pipeline.stages.map((s: any) => {
        const items = list.filter((o) => o.stage_id === s.id);
        const folded = prefs.collapsed.includes(s.id);
        const width = prefs.widths[s.id] ?? DEF_W;
        const style = { '--stage': s.color || 'var(--line)', ...(folded ? {} : { flexBasis: width, width }) } as CSSProperties;
        return (
          <div
            key={s.id}
            className={`kcol stage-col${folded ? ' folded' : ''}${s.color ? ' tinted' : ''}${over === s.id ? ' over' : ''}`}
            style={style}
            onDragOver={(e) => (e.preventDefault(), setOver(s.id))}
            onDragLeave={() => setOver('')}
            onDrop={(e) => (setOver(''), onMove(s.id, e.dataTransfer.getData('text/plain')))}
          >
            <div className="kcol-head stage-head">
              <span className="stage-dot" aria-hidden="true" />
              <strong className="stage-name" title={s.name}>
                {s.name}
              </strong>
              <button type="button" className="icon-btn stage-fold" aria-expanded={!folded} aria-label={folded ? t('Stufe {name} aufklappen', { name: s.name }) : t('Stufe {name} einklappen', { name: s.name })} title={folded ? t('Aufklappen') : t('Einklappen')} onClick={() => toggle(s.id)}>
                {folded ? '»' : '«'}
              </button>
              <div className="stage-stats muted">
                <span className="stage-count">{t.plural(items.length, { one: '{n} Deal', other: '{n} Deals' })}</span>
                <span className="stage-sum">{sums(items)}</span>
              </div>
            </div>
            {!folded && (
              <div className="kcol-body">
                {items.map((o) => (
                  <DealCard key={o.id} o={o} pipeline={pipeline} onOpen={onOpen} onMove={onMove} />
                ))}
              </div>
            )}
            {!folded && <Resizer name={s.name} width={width} onChange={(w, save) => setWidth(s.id, w, save)} />}
          </div>
        );
      })}
    </div>
  );
}

function Resizer({ name, width, onChange }: { name: string; width: number; onChange: (w: number | null, save: boolean) => void }) {
  const t = useT('deals');
  const start = useRef<{ x: number; w: number } | null>(null);
  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, w: width };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => start.current && onChange(start.current.w + e.clientX - start.current.x, false);
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    onChange(start.current.w + e.clientX - start.current.x, true);
    start.current = null;
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 60 : 20;
    if (e.key === 'ArrowLeft') (e.preventDefault(), onChange(width - step, true));
    else if (e.key === 'ArrowRight') (e.preventDefault(), onChange(width + step, true));
    else if (e.key === 'Home' || e.key === 'Escape') (e.preventDefault(), onChange(null, true));
  };
  return (
    <div
      className="stage-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('Breite der Stufe {name}', { name })}
      aria-valuenow={width}
      aria-valuemin={MIN_W}
      aria-valuemax={MAX_W}
      tabIndex={0}
      title={t('Ziehen ändert die Breite, Doppelklick setzt sie zurück')}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => (start.current = null)}
      onDoubleClick={() => onChange(null, true)}
      onKeyDown={key}
    />
  );
}

export function DealCard({ o, pipeline, onOpen, onMove }: { o: any; pipeline: any; onOpen: (o: any) => void; onMove: (stageId: string, oppId: string) => void }) {
  const t = useT('deals');
  const close = closeInfo(o);
  return (
    <div className="kcard" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', o.id)} {...pressable(() => (publishSelection({ contactId: o.contact_id }), onOpen(o)))}>
      <div>{o.name}</div>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 4 }}>
        <span className="v">{amount(o.value, o.currency)}</span>
        {o.status !== 'open' && <Badge tone={o.status === 'won' ? 'green' : 'red'}>{LOST_TEXT[o.status] ? t(LOST_TEXT[o.status]) : o.status}</Badge>}
      </div>
      <div className="muted small">{o.email || o.phone}</div>
      {o.status === 'open' && <DealSmartChips dealId={o.id} pipelineId={pipeline.id} />}
      {o.contact_tags?.length > 0 && (
        <div className="deal-tags">
          <TagChips tags={o.contact_tags} max={3} />
        </div>
      )}
      {close && (
        <div className={`deal-close small${close.late ? ' late' : ' muted'}`} title={t('Erwarteter Abschluss')}>
          {t('Abschluss {date}', { date: close.label })}
          {close.late && ` · ${t('überfällig')}`}
        </div>
      )}
      {o.status === 'lost' && o.lost_reason && <div className="muted small">{t('Grund: {reason}', { reason: o.lost_reason })}</div>}
      <MoveMenu what={t('Deal „{name}“', { name: o.name })} current={o.stage_id} targets={pipeline.stages.map((st: any) => ({ id: st.id, label: st.name }))} onMove={(stage) => onMove(stage, o.id)} />
    </div>
  );
}

/** Sorts the pipelines by drag & drop (or the arrow buttons); the order applies to everybody in the sub-account. */
export function PipelineOrder({ pipelines, onClose, onSaved }: { pipelines: any[]; onClose: () => void; onSaved: () => void }) {
  const t = useT('deals');
  const [list, setList] = useState<any[]>(pipelines);
  const [drag, setDrag] = useState<string | null>(null);
  const moveTo = (pid: string, to: number) => {
    const from = list.findIndex((p) => p.id === pid);
    if (from < 0 || to < 0 || to >= list.length || from === to) return;
    const next = [...list];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it);
    setList(next);
  };
  const save = async () => {
    if (await act(() => api.post('/api/pipelines/order', { ids: list.map((p) => p.id) }), t('Reihenfolge gespeichert'))) onSaved();
  };
  return (
    <Modal
      title={t('Pipelines sortieren')}
      onClose={onClose}
      footer={
        <button className="btn" onClick={save}>
          {t('Speichern')}
        </button>
      }
    >
      <p className="muted small" style={{ marginTop: 0 }}>
        {t('Ziehen oder mit den Pfeilen verschieben – die Reihenfolge gilt für alle im Sub-Account.')}
      </p>
      <ol className="pipe-order" data-tour="opps-pipeline-order">
        {list.map((p, i) => (
          <li
            key={p.id}
            draggable
            className={drag === p.id ? 'dragging' : undefined}
            onDragStart={(e) => (e.dataTransfer.setData('text/plain', p.id), setDrag(p.id))}
            onDragOver={(e) => {
              e.preventDefault();
              if (drag && drag !== p.id) moveTo(drag, i);
            }}
            onDragEnd={() => setDrag(null)}
            onDrop={(e) => (e.preventDefault(), setDrag(null))}
          >
            <span className="drag-grip" aria-hidden="true">
              ⠿
            </span>
            <span className="grow">{p.name}</span>
            <span className="muted small">{t.plural(p.open_count ?? 0, { one: '{n} offen', other: '{n} offen' })}</span>
            <button type="button" className="icon-btn" disabled={!i} onClick={() => moveTo(p.id, i - 1)} aria-label={t('{name} nach oben', { name: p.name })}>
              ↑
            </button>
            <button type="button" className="icon-btn" disabled={i === list.length - 1} onClick={() => moveTo(p.id, i + 1)} aria-label={t('{name} nach unten', { name: p.name })}>
              ↓
            </button>
          </li>
        ))}
      </ol>
    </Modal>
  );
}
