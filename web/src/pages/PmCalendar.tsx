import { useMemo, useState } from 'react';
import { Icon } from '../icons';
import { QuickAdd, addDay, applyFilters, dayOf, diffDay, fmtMonth, fmtShort, fmtWeekday, mondayOf, isWeekend, taskApi, todayIn, useStored, type Filters, type Meta, type ProjectDetail, type Task } from './PmKit';
import { useT } from '../i18n';

/** Calendar: tasks as bars from start to due date (one day when only one date is set). Drag to move, click a day to add. */

interface Seg {
  t: Task;
  col0: number;
  col1: number;
  contL: boolean;
  contR: boolean;
  segStart: string;
  lane: number;
}

function segments(week: string[], items: { t: Task; s: string; e: string }[]): { segs: Seg[]; lanes: number } {
  const first = week[0];
  const last = week[6];
  const raw = items
    .filter((x) => x.e >= first && x.s <= last)
    .map((x) => {
      const cs = x.s < first ? first : x.s;
      const ce = x.e > last ? last : x.e;
      return { t: x.t, col0: diffDay(first, cs), col1: diffDay(first, ce), contL: x.s < first, contR: x.e > last, segStart: cs, lane: 0 };
    })
    .sort((a, b) => a.col0 - b.col0 || b.col1 - b.col0 - (a.col1 - a.col0) || a.t.title.localeCompare(b.t.title, 'de'));
  const ends: number[] = [];
  for (const s of raw) {
    let l = ends.findIndex((e) => e < s.col0);
    if (l < 0) l = ends.length;
    ends[l] = s.col1;
    s.lane = l;
  }
  return { segs: raw, lanes: ends.length };
}

export function PmCalendar({ project, tasks, filters, meta, reload, openTask }: { project: ProjectDetail; tasks: Task[]; filters: Filters; meta: Meta; reload: () => Promise<unknown>; openTask: (id: string) => void }) {
  const t = useT('pm');
  const tz = meta.timezone;
  const today = todayIn(tz);
  const [mode, setMode] = useStored<'month' | 'week'>('cal-mode', 'month');
  const [anchor, setAnchor] = useState(today);
  const [drag, setDrag] = useState<{ id: string; from: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  const weeks = useMemo(() => {
    if (mode === 'week') {
      const m = mondayOf(anchor);
      return [Array.from({ length: 7 }, (_, i) => addDay(m, i))];
    }
    const [y, m] = anchor.split('-').map(Number);
    const first = `${anchor.slice(0, 7)}-01`;
    const start = mondayOf(first);
    const lastDay = addDay(new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10), -1);
    const out: string[][] = [];
    for (let w = start; w <= lastDay; w = addDay(w, 7)) out.push(Array.from({ length: 7 }, (_, i) => addDay(w, i)));
    return out;
  }, [mode, anchor]);

  const { dated, undated } = useMemo(() => {
    const rows = applyFilters(tasks, filters, tz, meta.me.id);
    const dated: { t: Task; s: string; e: string }[] = [];
    const undated: Task[] = [];
    for (const tk of rows) {
      const s = dayOf(tk.start_at, tz) ?? dayOf(tk.due_at, tz);
      const e = dayOf(tk.due_at, tz) ?? s;
      if (s && e) dated.push({ t: tk, s, e });
      else if (!tk.done) undated.push(tk);
    }
    return { dated, undated };
  }, [tasks, filters, tz, meta.me.id]);

  const monthOf = (ymd: string) => ymd.slice(0, 7);
  const step = (n: number) => {
    if (mode === 'week') return setAnchor(addDay(anchor, 7 * n));
    const [y, m] = anchor.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    setAnchor(d.toISOString().slice(0, 10));
  };

  const dropOn = async (day: string) => {
    const d = drag;
    setDrag(null);
    setOver(null);
    if (!d) return;
    const tk = tasks.find((x) => x.id === d.id);
    if (!tk) return;
    const s = dayOf(tk.start_at, tz);
    const e = dayOf(tk.due_at, tz);
    if (!s && !e) {
      if (await taskApi.dates(tk.id, { due: day })) await reload();
      return;
    }
    const delta = diffDay(d.from, day);
    if (!delta) return;
    if (await taskApi.dates(tk.id, { start: s ? addDay(s, delta) : null, due: e ? addDay(e, delta) : null })) await reload();
  };

  return (
    <div className="pm-calview" data-tour="pm-calendar">
      <div className="pm-cal-bar">
        <div className="actions">
          <button type="button" className="btn small secondary" aria-label={t('Zurück')} onClick={() => step(-1)}>
            ‹
          </button>
          <button type="button" className="btn small secondary" onClick={() => setAnchor(today)}>
            {t('Heute')}
          </button>
          <button type="button" className="btn small secondary" aria-label={t('Weiter')} onClick={() => step(1)}>
            ›
          </button>
        </div>
        <h3 className="pm-cal-title">{mode === 'week' ? `${fmtShort(weeks[0][0])} – ${fmtShort(weeks[0][6])}` : fmtMonth(anchor)}</h3>
        <span className="grow" />
        <div className="pm-seg" role="group" aria-label={t('Darstellung')}>
          <button type="button" className={mode === 'month' ? 'on' : ''} aria-pressed={mode === 'month'} onClick={() => setMode('month')}>
            {t('Monat')}
          </button>
          <button type="button" className={mode === 'week' ? 'on' : ''} aria-pressed={mode === 'week'} onClick={() => setMode('week')}>
            {t('Woche')}
          </button>
        </div>
      </div>
      <div className="pm-cal-layout">
        <div className="pm-cal" role="grid" aria-label={t('Kalender')}>
          <div className="pm-cal-head" role="row">
            {weeks[0].map((d) => (
              <span key={d} role="columnheader">
                {fmtWeekday(d)}
              </span>
            ))}
          </div>
          {weeks.map((week) => {
            const { segs, lanes } = segments(week, dated);
            return (
              <div key={week[0]} className={`pm-cal-week${mode === 'week' ? ' tall' : ''}`} role="row">
                <div className="pm-cal-days">
                  {week.map((d) => (
                    <div
                      key={d}
                      role="gridcell"
                      className={`pm-cal-day${d === today ? ' today' : ''}${isWeekend(d) ? ' we' : ''}${mode === 'month' && monthOf(d) !== monthOf(anchor) ? ' other' : ''}${over === d ? ' over' : ''}`}
                      onDragOver={(e) => (drag ? (e.preventDefault(), setOver(d)) : undefined)}
                      onDragLeave={() => over === d && setOver(null)}
                      onDrop={(e) => (e.preventDefault(), void dropOn(d))}
                      onDoubleClick={() => setAdding(d)}
                    >
                      <span className="pm-cal-num">
                        {d.slice(8) === '01' || d === week[0] ? fmtShort(d) : Number(d.slice(8))}
                        <button type="button" className="pm-cal-add" aria-label={t('Aufgabe am {date} hinzufügen', { date: fmtShort(d) })} onClick={() => setAdding(adding === d ? null : d)}>
                          +
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
                <div className="pm-cal-lanes" style={{ gridTemplateRows: `repeat(${Math.max(lanes, 1)}, 26px)` }}>
                  {segs.map((s) => (
                    <button
                      key={`${s.t.id}-${s.col0}`}
                      type="button"
                      draggable
                      className={`pm-bar-chip${s.t.done ? ' done' : ''}${s.contL ? ' contl' : ''}${s.contR ? ' contr' : ''}${s.t.milestone ? ' ms' : ''}`}
                      style={{ gridColumn: `${s.col0 + 1} / ${s.col1 + 2}`, gridRow: s.lane + 1, '--c': s.t.status?.color ?? project.color } as React.CSSProperties}
                      title={`${s.t.title}${s.t.assignees.length ? ` · ${s.t.assignees.map((a) => a.name).join(', ')}` : ''}`}
                      onDragStart={(e) => {
                        setDrag({ id: s.t.id, from: s.segStart });
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', s.t.id);
                      }}
                      onDragEnd={() => (setDrag(null), setOver(null))}
                      onClick={() => openTask(s.t.id)}
                    >
                      {s.t.milestone && <Icon name="flag" size={11} />} {s.t.title}
                    </button>
                  ))}
                </div>
                {adding && week.includes(adding) && (
                  <div className="pm-cal-quick" style={{ gridColumn: 1 }}>
                    <strong className="small">{fmtShort(adding)}</strong>
                    <QuickAdd
                      small
                      placeholder={t('Neue Aufgabe…')}
                      onAdd={async (title) => {
                        if (await taskApi.create({ title, project_id: project.id, due_at: adding })) (setAdding(null), await reload());
                      }}
                    />
                    <button type="button" className="icon-btn" aria-label={t('Schließen')} onClick={() => setAdding(null)}>
                      ✕
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <aside className="pm-cal-undated" aria-label={t('Aufgaben ohne Datum')}>
          <h4>{t('Ohne Datum (')}{undated.length})</h4>
          <p className="muted small">{t('Auf einen Tag ziehen, um ein Fälligkeitsdatum zu setzen.')}</p>
          {undated.slice(0, 40).map((tk) => (
            <button
              key={tk.id}
              type="button"
              draggable
              className="pm-undated"
              onDragStart={(e) => {
                setDrag({ id: tk.id, from: today });
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', tk.id);
              }}
              onDragEnd={() => (setDrag(null), setOver(null))}
              onClick={() => openTask(tk.id)}
            >
              {tk.title}
            </button>
          ))}
          {!undated.length && <p className="muted small">{t('Alle Aufgaben haben ein Datum.')}</p>}
        </aside>
      </div>
    </div>
  );
}
