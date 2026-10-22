import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { fmtDate, fmtTime, useT } from '../i18n';
import { clamp, hm, layout, snap, zoned, type Appt } from './calview-model';

/**
 * The grids of the calendar view: a time grid (day, week, team – one column per day or per person), the month grid and the agenda
 * list for phones. They only draw and report gestures (open, book a slot, drop, keyboard moves); CalendarView.tsx does the rest.
 */

export const PX_PER_MIN = 0.8;
const SNAP = 15;

export interface Span {
  from: number;
  to: number;
}
export interface ColItem extends Span {
  appt: Appt;
  /** Starts before / ends after this column's day. */
  cutTop: boolean;
  cutBottom: boolean;
}
export interface Column {
  key: string;
  ymd: string;
  label: string;
  sub?: string;
  personId?: string | null;
  today?: boolean;
  items: ColItem[];
  open: Span[];
  buffers: Span[];
  busy: (Span & { label: string })[];
  absences: (Span & { label: string })[];
  tasks: { id: string; min: number; title: string; done: boolean }[];
  allDay: { key: string; label: string; kind: 'task' | 'absence' | 'item'; done?: boolean; color?: string; onClick?: () => void }[];
}

export interface Drop {
  appt: Appt;
  col: number;
  from: number;
  to: number;
  resized: boolean;
}

type Drag = { id: string; mode: 'move' | 'resize'; x: number; y: number; col: number; from: number; to: number; dMin: number; dCol: number; moved: boolean };

const statusText: Record<string, string> = { confirmed: 'bestätigt', showed: 'erschienen', noshow: 'nicht erschienen', cancelled: 'abgesagt', blocked: 'blockiert' };

function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function TimeGrid({
  columns,
  hours,
  nowMin,
  colorOf,
  lockColumns,
  onSlot,
  onOpen,
  onDrop,
  onKeyMove,
  openTask,
}: {
  columns: Column[];
  hours: { start: number; end: number };
  nowMin: number | null;
  colorOf: (a: Appt) => string;
  lockColumns?: boolean;
  onSlot: (col: number, min: number) => void;
  onOpen: (a: Appt) => void;
  onDrop: (d: Drop) => void;
  onKeyMove: (a: Appt, col: number, kind: 'move' | 'resize' | 'day', delta: number) => void;
  openTask?: (id: string) => void;
}) {
  const t = useT('calview');
  const body = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  useNow();
  const top0 = hours.start * 60;
  const height = (hours.end - hours.start) * 60 * PX_PER_MIN;
  const y = (min: number) => (clamp(min, top0, hours.end * 60) - top0) * PX_PER_MIN;

  // Scroll to the morning (or the current time) once.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // the current time on a working day, else the morning
    const target = nowMin !== null && nowMin >= 8 * 60 && nowMin <= 18 * 60 ? nowMin - 90 : 7.5 * 60;
    el.scrollTop = Math.max(0, (target - top0) * PX_PER_MIN);
  }, [top0]); // eslint-disable-line react-hooks/exhaustive-deps

  const colWidth = () => (body.current ? body.current.getBoundingClientRect().width / Math.max(1, columns.length) : 1);
  const start = (e: React.PointerEvent, it: ColItem, col: number, mode: Drag['mode']) => {
    if (e.button !== 0 || it.appt.status === 'cancelled') return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setDrag({ id: it.appt.id, mode, x: e.clientX, y: e.clientY, col, from: it.from, to: it.to, dMin: 0, dCol: 0, moved: false });
  };
  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    const dMin = snap((e.clientY - drag.y) / PX_PER_MIN, SNAP);
    const dCol = drag.mode === 'move' && !lockColumns ? clamp(Math.round((e.clientX - drag.x) / colWidth()), -drag.col, columns.length - 1 - drag.col) : 0;
    const moved = drag.moved || Math.abs(e.clientY - drag.y) > 4 || Math.abs(e.clientX - drag.x) > 6;
    if (dMin !== drag.dMin || dCol !== drag.dCol || moved !== drag.moved) setDrag({ ...drag, dMin, dCol, moved });
  };
  const end = (it: ColItem) => {
    const d = drag;
    setDrag(null);
    if (!d) return;
    if (!d.moved || (d.dMin === 0 && d.dCol === 0)) return onOpen(it.appt);
    if (d.mode === 'resize') onDrop({ appt: it.appt, col: d.col, from: d.from, to: Math.max(d.from + SNAP, d.to + d.dMin), resized: true });
    else onDrop({ appt: it.appt, col: d.col + d.dCol, from: d.from + d.dMin, to: d.to + d.dMin, resized: false });
  };
  const slotClick = (e: React.MouseEvent, col: number) => {
    if ((e.target as HTMLElement).closest('.cv-ev, .cv-task')) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    onSlot(col, clamp(Math.floor((e.clientY - rect.top) / PX_PER_MIN / SNAP) * SNAP + top0, 0, 1440 - SNAP));
  };
  const keyOnEvent = (e: React.KeyboardEvent, it: ColItem, col: number) => {
    if (!e.altKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return; // i18n-ignore (key names)
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (!lockColumns) onKeyMove(it.appt, col, 'day', e.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    onKeyMove(it.appt, col, e.shiftKey ? 'resize' : 'move', e.key === 'ArrowUp' ? -SNAP : SNAP);
  };

  const hasAllDay = columns.some((c) => c.allDay.length);
  const cssCols = { gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` } as CSSProperties;
  return (
    <div className="cv-time" data-tour="calview-grid">
      <div className="cv-scroll" ref={scroller}>
        <div className="cv-sticky">
          <div className="cv-head">
            <div className="cv-gutter" />
            <div className="cv-head-cols" style={cssCols}>
              {columns.map((c) => (
                <div key={c.key} className={`cv-head-col${c.today ? ' today' : ''}`}>
                  <strong>{c.label}</strong>
                  {c.sub && <span className="muted small">{c.sub}</span>}
                </div>
              ))}
            </div>
          </div>
          {hasAllDay && (
            <div className="cv-allday">
              <div className="cv-gutter muted small">{t('ganztägig')}</div>
              <div className="cv-head-cols" style={cssCols}>
                {columns.map((c) => (
                  <div key={c.key} className="cv-allday-col">
                    {c.allDay.map((x) =>
                      x.onClick ? (
                        <button key={x.key} type="button" className={`cv-chip ${x.kind}${x.done ? ' done' : ''}`} onClick={x.onClick} title={x.label} style={x.color ? { borderLeft: `3px solid ${x.color}` } : undefined}>
                          {x.label}
                        </button>
                      ) : (
                        <span key={x.key} className={`cv-chip ${x.kind}${x.done ? ' done' : ''}`} title={x.label}>
                          {x.label}
                        </span>
                      ),
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="cv-grid-body">
          <div className="cv-gutter cv-hours" style={{ height }}>
            {Array.from({ length: hours.end - hours.start }, (_, i) => (
              <span key={i} style={{ top: i * 60 * PX_PER_MIN }}>
                {hm((hours.start + i) * 60)}
              </span>
            ))}
          </div>
          <div className="cv-cols" ref={body} style={{ ...cssCols, height }}>
            {columns.map((c, ci) => {
              const placed = layout(c.items.map((it) => ({ id: it.appt.id, from: it.from, to: it.to })));
              return (
                <div
                    key={c.key}
                    className={`cv-col${c.today ? ' today' : ''}`}
                    onClick={(e) => slotClick(e, ci)}
                    tabIndex={0}
                    aria-label={t('Termin eintragen: {day}', { day: c.sub ? `${c.label} ${c.sub}` : c.label })}
                    onKeyDown={(e) => e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSlot(ci, Math.max(top0, 9 * 60)))}
                    data-day={c.ymd}
                  >
                  {c.open.map((s, i) => (
                    <div key={`o${i}`} className="cv-open" style={{ top: y(s.from), height: y(s.to) - y(s.from) }} />
                  ))}
                  {c.buffers.map((s, i) => (
                    <div key={`b${i}`} className="cv-buffer" style={{ top: y(s.from), height: Math.max(2, y(s.to) - y(s.from)) }} title={t('Puffer')} />
                  ))}
                  {c.busy.map((s, i) => (
                    <div key={`x${i}`} className="cv-busy" style={{ top: y(s.from), height: Math.max(10, y(s.to) - y(s.from)) }} title={s.label}>
                      <span>{t('belegt')}</span>
                    </div>
                  ))}
                  {c.absences.map((s, i) => (
                    <div key={`a${i}`} className="cv-absence" style={{ top: y(s.from), height: Math.max(10, y(s.to) - y(s.from)) }} title={s.label}>
                      <span>{s.label}</span>
                    </div>
                  ))}
                  {c.items.map((it) => {
                    const p = placed.get(it.appt.id) ?? { col: 0, cols: 1 };
                    const d = drag?.id === it.appt.id ? drag : null;
                    const from = d && d.mode === 'move' ? it.from + d.dMin : it.from;
                    const to = d ? (d.mode === 'move' ? it.to + d.dMin : Math.max(it.from + SNAP, it.to + d.dMin)) : it.to;
                    const shiftX = d && d.mode === 'move' ? d.dCol : 0;
                    const a = it.appt;
                    const label = `${hm(it.from)}–${hm(it.to)}, ${a.contact_name || a.title}, ${t(statusText[a.status] ?? a.status)}`;
                    const short = to - from < 40;
                    return (
                      <button
                        key={a.id}
                        type="button"
                        className={`cv-ev st-${a.status}${d?.moved ? ' dragging' : ''}${it.cutTop ? ' cut-top' : ''}${it.cutBottom ? ' cut-bottom' : ''}${short ? ' short' : ''}`}
                        style={
                          {
                            top: y(from),
                            height: Math.max(14, y(to) - y(from)),
                            left: `calc(${(p.col / p.cols) * 100}% + ${shiftX * 100}% + 1px)`,
                            width: `calc(${100 / p.cols}% - 3px)`,
                            ['--ev' as string]: colorOf(a),
                          } as CSSProperties
                        }
                        aria-label={label}
                        title={label}
                        onPointerDown={(e) => start(e, it, ci, 'move')}
                        onPointerMove={move}
                        onPointerUp={() => end(it)}
                        onPointerCancel={() => setDrag(null)}
                        onClick={(e) => e.preventDefault()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onOpen(a);
                          } else keyOnEvent(e, it, ci);
                        }}
                      >
                        <span className="cv-ev-time">
                          {hm(from)}
                          {!short && `–${hm(to)}`}
                          {a.series_id && (
                            <span className="cv-rep" aria-hidden="true">
                              {' '}
                              ↻
                            </span>
                          )}
                        </span>
                        <span className="cv-ev-title">{a.status === 'blocked' ? a.title : a.contact_name || a.title}</span>
                        {a.status !== 'cancelled' && a.status !== 'blocked' && <span className="cv-resize" onPointerDown={(e) => start(e, it, ci, 'resize')} aria-hidden="true" />}
                      </button>
                    );
                  })}
                  {c.tasks.map((x) => (
                    <button key={x.id} type="button" className={`cv-task${x.done ? ' done' : ''}`} style={{ top: y(x.min) }} onClick={() => openTask?.(x.id)} title={x.title}>
                      {x.done ? '☑' : '☐'} {x.title}
                    </button>
                  ))}
                  {c.today && nowMin !== null && nowMin >= top0 && nowMin <= hours.end * 60 && <div className="cv-now" style={{ top: y(nowMin) }} aria-hidden="true" />}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export interface DayBucket {
  appts: Appt[];
  tasks: { id: string; title: string; done: boolean; min: number | null }[];
  absences: { key: string; label: string }[];
}

export function MonthGrid({
  days,
  month,
  today,
  tz,
  byDay,
  colorOf,
  onDay,
  onSlot,
  onOpen,
  onMoveDay,
  openTask,
}: {
  days: string[];
  month: string;
  today: string;
  tz: string;
  byDay: Map<string, DayBucket>;
  colorOf: (a: Appt) => string;
  onDay: (ymd: string) => void;
  onSlot: (ymd: string) => void;
  onOpen: (a: Appt) => void;
  onMoveDay: (a: Appt, ymd: string) => void;
  openTask?: (id: string) => void;
}) {
  const t = useT('calview');
  const [over, setOver] = useState<string | null>(null);
  const dragging = useRef<Appt | null>(null);
  const MAX = 4;
  const weekNames = days.slice(0, 7).map((d) => fmtDate(`${d}T12:00:00Z`, { weekday: 'short', timeZone: 'UTC' }));
  const time = (iso: string) => fmtTime(iso, { hour: '2-digit', minute: '2-digit', timeZone: tz });
  return (
    <div className="cv-month" data-tour="calview-grid">
      <div className="cv-month-head">
        {weekNames.map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>
      <div className="cv-month-body">
        {days.map((d) => {
          const b = byDay.get(d) ?? { appts: [], tasks: [], absences: [] };
          const items: ReactNode[] = [];
          for (const x of b.absences)
            items.push(
              <span key={x.key} className="cv-chip absence" title={x.label}>
                {x.label}
              </span>,
            );
          for (const a of b.appts.slice(0, MAX)) {
            items.push(
              <button
                key={a.id}
                type="button"
                draggable={a.status !== 'cancelled'}
                className={`cv-mchip st-${a.status}`}
                style={{ ['--ev' as string]: colorOf(a) } as CSSProperties}
                onClick={(e) => (e.stopPropagation(), onOpen(a))}
                onDragStart={(e) => {
                  dragging.current = a;
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', a.id);
                }}
                onDragEnd={() => ((dragging.current = null), setOver(null))}
                title={`${time(a.start_at)} ${a.contact_name || a.title}`}
              >
                <span className="cv-mchip-time">{time(a.start_at)}</span> {a.status === 'blocked' ? a.title : a.contact_name || a.title}
              </button>,
            );
          }
          for (const x of b.tasks.slice(0, 3))
            items.push(
              <button key={x.id} type="button" className={`cv-chip task${x.done ? ' done' : ''}`} onClick={(e) => (e.stopPropagation(), openTask?.(x.id))} title={x.title}>
                {x.done ? '☑' : '☐'} {x.title}
              </button>,
            );
          const more = b.appts.length - MAX;
          return (
            <div
              key={d}
              className={`cv-mday${d.slice(0, 7) !== month ? ' other' : ''}${d === today ? ' today' : ''}${over === d ? ' over' : ''}`}
              onClick={() => onSlot(d)}
              tabIndex={0}
              aria-label={t('Termin eintragen: {day}', { day: fmtDate(`${d}T12:00:00Z`, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) })}
              onKeyDown={(e) => e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSlot(d))}
              onDragOver={(e) => {
                if (!dragging.current) return;
                e.preventDefault();
                if (over !== d) setOver(d);
              }}
              onDragLeave={() => over === d && setOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                const a = dragging.current;
                dragging.current = null;
                setOver(null);
                if (a) onMoveDay(a, d);
              }}
            >
              <button
                type="button"
                className="cv-mday-num"
                onClick={(e) => (e.stopPropagation(), onDay(d))}
                aria-label={t('Tag öffnen: {date}', { date: fmtDate(`${d}T12:00:00Z`, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) })}
              >
                {Number(d.slice(8))}
              </button>
              <div className="cv-mday-items">{items}</div>
              {more > 0 && (
                <button type="button" className="cv-more" onClick={(e) => (e.stopPropagation(), onDay(d))}>
                  {t.plural(more, { one: '+{n} weiterer', other: '+{n} weitere' })}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AgendaList({
  days,
  tz,
  today,
  byDay,
  colorOf,
  onOpen,
  onSlot,
  openTask,
}: {
  days: string[];
  tz: string;
  today: string;
  byDay: Map<string, DayBucket>;
  colorOf: (a: Appt) => string;
  onOpen: (a: Appt) => void;
  onSlot: (ymd: string) => void;
  openTask?: (id: string) => void;
}) {
  const t = useT('calview');
  const time = (iso: string) => fmtTime(iso, { hour: '2-digit', minute: '2-digit', timeZone: tz });
  const taskRow = (x: DayBucket['tasks'][number]) => (
    <button key={`t${x.id}`} type="button" className={`cv-arow task${x.done ? ' done' : ''}`} onClick={() => openTask?.(x.id)}>
      <span className="cv-atime">{x.min === null ? t('Aufgabe') : hm(x.min)}</span>
      <span className="cv-atitle">
        {x.done ? '☑' : '☐'} {x.title}
      </span>
    </button>
  );
  const zonedOf = (d: string, min: number) => zoned(d, min, tz);
  const shown = days.filter((d) => d === today || (byDay.get(d)?.appts.length ?? 0) + (byDay.get(d)?.tasks.length ?? 0) + (byDay.get(d)?.absences.length ?? 0) > 0);
  return (
    <div className="cv-agenda" data-tour="calview-grid">
      {!shown.length && <p className="muted">{t('Keine Termine in diesen zwei Wochen.')}</p>}
      {shown.map((d) => {
        const b = byDay.get(d) ?? { appts: [], tasks: [], absences: [] };
        return (
          <section key={d} className={`cv-aday${d === today ? ' today' : ''}`}>
            <h3>
              <span>{fmtDate(`${d}T12:00:00Z`, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}</span>
              {d === today && <span className="cv-today-badge">{t('Heute')}</span>}
              <button type="button" className="icon-btn" onClick={() => onSlot(d)} aria-label={t('Termin an diesem Tag eintragen')}>
                +
              </button>
            </h3>
            {b.absences.map((x) => (
              <div key={x.key} className="cv-arow absence">
                <span className="cv-atime">{t('ganztägig')}</span>
                <span>{x.label}</span>
              </div>
            ))}
            {[
              ...b.tasks.filter((x) => x.min === null).map((x) => ({ at: -1, key: `t${x.id}`, node: taskRow(x) })),
              ...b.appts.map((a) => ({
                at: Date.parse(a.start_at),
                key: a.id,
                node: (
                  <button key={a.id} type="button" className={`cv-arow st-${a.status}`} style={{ ['--ev' as string]: colorOf(a) } as CSSProperties} onClick={() => onOpen(a)}>
                    <span className="cv-atime">
                      {time(a.start_at)}–{time(a.end_at)}
                    </span>
                    <span className="cv-atitle">
                      <strong>{a.status === 'blocked' ? a.title : a.contact_name || a.title}</strong>
                      <span className="muted small">
                        {t(statusText[a.status] ?? a.status)}
                        {a.series_id ? ` · ${t('Serie')}` : ''}
                      </span>
                    </span>
                  </button>
                ),
              })),
              ...b.tasks.filter((x) => x.min !== null).map((x) => ({ at: Date.parse(zonedOf(d, x.min!)), key: `t${x.id}`, node: taskRow(x) })),
            ]
              .sort((p, q) => p.at - q.at)
              .map((x) => x.node)}
          </section>
        );
      })}
    </div>
  );
}
