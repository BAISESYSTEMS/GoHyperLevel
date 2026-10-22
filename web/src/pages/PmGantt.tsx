import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { CALENDAR_DAYS, CALENDAR_WORKDAYS, durationOf, endFromDuration, snapDay, type Calendar } from '../../../server/services/pm-schedule';
import { Icon } from '../icons';
import { act, confirmAsk, toast, useLoad } from '../ui';
import { Avatar, Pop, QuickAdd, addDay, diffDay, fmtMon, fmtShort, fmtWeekday, isWeekend, isoWeek, mondayOf, taskApi, useStored, type Meta, type ProjectDetail, type Section, type Status } from './PmKit';
import { useT } from '../i18n';

/** Gantt: bars you drag and stretch, dependency arrows you draw, the critical path, baseline and three zoom levels. */

interface GTask {
  id: string;
  parent_id: string | null;
  section_id: string | null;
  depth: number;
  title: string;
  start: string | null;
  end: string | null;
  scheduled: boolean;
  done: boolean;
  milestone: boolean;
  priority: number;
  status: { id: string; name: string; category: string; color: string } | null;
  assignees: { id: string; name: string }[];
  progress: number;
  estimate_minutes: number | null;
  blocked: boolean;
  baseline: { start: string; end: string } | null;
  float: number | null;
  critical: boolean;
  has_children: boolean;
}
interface GDep {
  id: string;
  task: string;
  on: string;
  type: 'FS' | 'SS' | 'FF' | 'SF';
  lag: number;
  critical: boolean;
  violated: boolean;
}
interface Gantt {
  project: { id: string; name: string; color: string; skip_weekends: boolean; baseline_at: string | null; start: string | null; end: string | null };
  today: string;
  tasks: GTask[];
  deps: GDep[];
  sections: Section[];
  statuses: Status[];
  bounds: { start: string; end: string } | null;
  critical_end: string | null;
}

type Zoom = 'day' | 'week' | 'month';
const DAY_W: Record<Zoom, number> = { day: 34, week: 15, month: 4.4 };
const ROW_H = 34;
const BAR_H = 18;
const HEAD_H = 54;
const GAP = 9;
// German labels (message ids of the pm catalog), shown through t()
const DEP_LABEL: Record<string, string> = { FS: 'Ende → Start', SS: 'Start → Start', FF: 'Ende → Ende', SF: 'Start → Ende' };

type Row = { kind: 'section'; key: string; name: string; count: number } | { kind: 'task'; key: string; t: GTask };
interface Drag {
  kind: 'move' | 'start' | 'end' | 'draw' | 'link';
  id: string;
  x0: number;
  orig: { start: string; end: string } | null;
  cur: { start: string; end: string } | null;
  px: number;
  py: number;
  target: string | null;
  moved: boolean;
}

export function PmGantt({ project, meta, version, reload, openTask }: { project: ProjectDetail; meta: Meta; version: number; reload: () => Promise<unknown>; openTask: (id: string) => void }) {
  const t = useT('pm');
  const g = useLoad(() => api.get<Gantt>(`/api/pm/projects/${project.id}/gantt`), [project.id]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void g.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  const [zoom, setZoom] = useStored<Zoom>('gantt-zoom', 'week');
  const [crit, setCrit] = useStored<'on' | 'off'>('gantt-crit', 'on');
  const [base, setBase] = useStored<'on' | 'off'>('gantt-base', 'off');
  const [hideDone, setHideDone] = useStored<'on' | 'off'>('gantt-hide-done', 'off');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const [selDep, setSelDep] = useState<{ id: string; x: number; y: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 720);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < 720);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  const data = g.data;
  const cal: Calendar = data?.project.skip_weekends ? CALENDAR_WORKDAYS : CALENDAR_DAYS;
  const dw = DAY_W[zoom];
  const leftW = narrow ? 150 : 310;

  // --- rows (sections, hierarchy, collapsed branches) ----------------------------------------------------------
  const rows = useMemo<Row[]>(() => {
    if (!data) return [];
    const out: Row[] = [];
    const hidden = new Set<string>();
    let lastSection: string | null | undefined;
    const sectionCount = new Map<string, number>();
    for (const tk of data.tasks) if (!tk.parent_id) sectionCount.set(tk.section_id ?? '', (sectionCount.get(tk.section_id ?? '') ?? 0) + 1);
    for (const tk of data.tasks) {
      if (hideDone === 'on' && tk.done) continue;
      if (!tk.parent_id) {
        const key = tk.section_id ?? '';
        if (key !== lastSection) {
          lastSection = key;
          const name = data.sections.find((s) => s.id === key)?.name ?? (data.sections.length ? t('Ohne Abschnitt') : '');
          if (name) out.push({ kind: 'section', key: `sec:${key}`, name, count: sectionCount.get(key) ?? 0 });
        }
        if (collapsed.has(`sec:${key}`)) {
          hidden.add(tk.id);
          continue;
        }
      }
      if ((tk.parent_id && hidden.has(tk.parent_id)) || (tk.parent_id && collapsed.has(tk.parent_id))) {
        hidden.add(tk.id);
        continue;
      }
      out.push({ kind: 'task', key: tk.id, t: tk });
    }
    return out;
  }, [data, collapsed, hideDone]);
  const rowOf = useMemo(() => new Map(rows.flatMap((r, i) => (r.kind === 'task' ? [[r.t.id, i] as const] : []))), [rows]);

  // --- time axis ----------------------------------------------------------------------------------------------------
  const axis = useMemo(() => {
    const today = data?.today ?? new Date().toISOString().slice(0, 10);
    const b = data?.bounds ?? { start: today, end: addDay(today, 30) };
    const start = mondayOf(addDay(b.start < today ? b.start : today, -10));
    let end = addDay(b.end > today ? b.end : today, 30);
    if (diffDay(start, end) < 56) end = addDay(start, 56);
    return { start, end, today, days: diffDay(start, end) + 1 };
  }, [data]);
  const X = (ymd: string) => diffDay(axis.start, ymd) * dw;
  const width = axis.days * dw;
  const height = Math.max(rows.length, 1) * ROW_H;
  const dayAt = (x: number) => addDay(axis.start, Math.max(0, Math.min(axis.days - 1, Math.floor(x / dw))));

  const head = useMemo(() => {
    const top: { x: number; w: number; label: string }[] = [];
    const bottom: { x: number; w: number; label: string; sub?: string; we?: boolean; today?: boolean }[] = [];
    const days: string[] = Array.from({ length: axis.days }, (_, i) => addDay(axis.start, i));
    if (zoom === 'day') {
      days.forEach((d, i) => {
        bottom.push({ x: i * dw, w: dw, label: String(Number(d.slice(8))), sub: fmtWeekday(d).slice(0, 2), we: isWeekend(d), today: d === axis.today });
        if (new Date(`${d}T00:00:00Z`).getUTCDay() === 1) {
          const w = Math.min(7, axis.days - i);
          top.push({ x: i * dw, w: w * dw, label: `${t('KW {n}', { n: isoWeek(d) })} · ${fmtShort(d)}` });
        }
      });
    } else if (zoom === 'week') {
      days.forEach((d, i) => {
        if (new Date(`${d}T00:00:00Z`).getUTCDay() === 1) bottom.push({ x: i * dw, w: Math.min(7, axis.days - i) * dw, label: t('KW {n}', { n: isoWeek(d) }), today: axis.today >= d && axis.today <= addDay(d, 6) });
        if (i === 0 || d.slice(8) === '01') {
          const month = d.slice(0, 7);
          let n = 0;
          while (i + n < days.length && days[i + n].slice(0, 7) === month) n++;
          top.push({ x: i * dw, w: n * dw, label: `${fmtMon(d)} ${d.slice(0, 4)}` });
        }
      });
    } else {
      days.forEach((d, i) => {
        if (i === 0 || d.slice(8) === '01') {
          const month = d.slice(0, 7);
          let n = 0;
          while (i + n < days.length && days[i + n].slice(0, 7) === month) n++;
          bottom.push({ x: i * dw, w: n * dw, label: fmtMon(d), today: axis.today.slice(0, 7) === month });
        }
        if (i === 0 || d.slice(5) === '01-01') {
          const year = d.slice(0, 4);
          let n = 0;
          while (i + n < days.length && days[i + n].slice(0, 4) === year) n++;
          top.push({ x: i * dw, w: n * dw, label: year });
        }
      });
    }
    return { top, bottom };
  }, [axis, zoom, dw]);

  // scroll to "today" when the chart appears or the zoom changes
  const scrolled = useRef('');
  useEffect(() => {
    if (!data || !scroller.current) return;
    const key = `${project.id}:${zoom}`;
    if (scrolled.current === key) return;
    scrolled.current = key;
    scroller.current.scrollLeft = Math.max(0, X(axis.today) - scroller.current.clientWidth / 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, zoom]);

  // --- geometry of one task ----------------------------------------------------------------------------------------
  const datesOf = (tk: GTask): { start: string; end: string } | null => {
    if (drag && drag.id === tk.id && drag.cur && drag.kind !== 'link') return drag.cur;
    return tk.start && tk.end ? { start: tk.start, end: tk.end } : null;
  };
  const edge = (tk: GTask, side: 'S' | 'F'): { x: number; y: number } | null => {
    const d = datesOf(tk);
    const i = rowOf.get(tk.id);
    if (!d || i === undefined) return null;
    return { x: side === 'S' ? X(d.start) : X(addDay(d.end, 1)), y: i * ROW_H + ROW_H / 2 };
  };
  const byId = useMemo(() => new Map((data?.tasks ?? []).map((tk) => [tk.id, tk])), [data]);

  const arrow = (d: GDep): string | null => {
    const pred = byId.get(d.on);
    const succ = byId.get(d.task);
    if (!pred || !succ) return null;
    const a = edge(pred, d.type[0] as 'S' | 'F');
    const b = edge(succ, d.type[1] as 'S' | 'F');
    if (!a || !b) return null;
    const sd = d.type[0] === 'F' ? 1 : -1;
    const td = d.type[1] === 'S' ? -1 : 1;
    const x1 = a.x + sd * GAP;
    // One bend when the vertical line fits between leaving the first bar and entering the second ...
    if (td < 0 ? x1 <= b.x - GAP : x1 >= b.x + GAP) return `M${a.x},${a.y} H${x1} V${b.y} H${b.x}`;
    // ... otherwise out, to the gap between the rows, across, and into the target from its own side.
    const ya = b.y === a.y ? a.y - ROW_H / 2 : b.y > a.y ? b.y - ROW_H / 2 : b.y + ROW_H / 2;
    const x3 = b.x + td * GAP;
    return `M${a.x},${a.y} H${x1} V${ya} H${x3} V${b.y} H${b.x}`;
  };

  // --- pointer handling ------------------------------------------------------------------------------------------------
  const local = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const startDrag = (e: React.PointerEvent, kind: Drag['kind'], tk: GTask) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const p = local(e);
    const orig = tk.start && tk.end ? { start: tk.start, end: tk.end } : null;
    svgRef.current!.setPointerCapture(e.pointerId);
    setSelDep(null);
    setDrag({ kind, id: tk.id, x0: p.x, orig, cur: orig, px: p.x, py: p.y, target: null, moved: false });
  };
  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const p = local(e);
    const moved = d.moved || Math.abs(p.x - d.x0) > 3;
    if (d.kind === 'link') {
      const row = Math.floor(p.y / ROW_H);
      const target = rows[row]?.kind === 'task' ? (rows[row] as { t: GTask }).t.id : null;
      return setDrag({ ...d, px: p.x, py: p.y, target: target && target !== d.id ? target : null, moved });
    }
    const delta = Math.round((p.x - d.x0) / dw);
    let cur = d.cur;
    if (d.kind === 'draw') {
      const a = dayAt(d.x0);
      const b = dayAt(p.x);
      cur = a <= b ? { start: a, end: b } : { start: b, end: a };
    } else if (d.orig) {
      const sgn = delta < 0 ? -1 : 1;
      if (d.kind === 'move') {
        const start = snapDay(addDay(d.orig.start, delta), cal, sgn);
        cur = { start, end: endFromDuration(start, durationOf(d.orig, cal), cal) };
      } else if (d.kind === 'start') {
        const s = snapDay(addDay(d.orig.start, delta), cal, sgn);
        cur = { start: s > d.orig.end ? d.orig.end : s, end: d.orig.end };
      } else {
        const en = snapDay(addDay(d.orig.end, delta), cal, sgn);
        cur = { start: d.orig.start, end: en < d.orig.start ? d.orig.start : en };
      }
    }
    setDrag({ ...d, cur, px: p.x, py: p.y, moved });
  };
  const onUp = async () => {
    const d = dragRef.current;
    setDrag(null);
    if (!d) return;
    if (d.kind === 'link') {
      if (!d.target) return;
      const r = await act(() => api.post(`/api/pm/tasks/${d.target}/dependencies`, { depends_on: d.id, type: 'FS', lag: 0 }), t('Abhängigkeit angelegt'));
      if (!r) return;
      // The new successor may start too early: push it (and everything after it) behind its predecessor.
      const pred = byId.get(d.id);
      if (pred?.start && pred.end) await taskApi.dates(d.id, { start: pred.start, due: pred.end, cascade: true });
      await reload();
      return;
    }
    if (d.kind === 'draw') {
      if (!d.cur) return;
      if (await taskApi.dates(d.id, { start: d.cur.start, due: d.cur.end })) await reload();
      return;
    }
    if (!d.moved || !d.cur || !d.orig || (d.cur.start === d.orig.start && d.cur.end === d.orig.end)) {
      if (!d.moved && d.kind === 'move') openTask(d.id);
      return;
    }
    if (await taskApi.dates(d.id, { start: d.cur.start, due: d.cur.end, cascade: true })) await reload();
  };

  if (g.error && !data) return <p className="pm-error">{g.error}</p>;
  if (!data) return <div className="pm-loading">{t('Gantt lädt…')}</div>;

  const violated = data.deps.filter((d) => d.violated).length;
  const critCount = data.tasks.filter((tk) => tk.critical).length;
  const selDepRow = selDep ? data.deps.find((d) => d.id === selDep.id) : undefined;

  const autoSchedule = async () => {
    const dry = await act(() => api.post<{ changed: number; tasks: { title: string; start: string; end: string }[] }>(`/api/pm/projects/${project.id}/auto-schedule`, { dry_run: true }));
    if (!dry) return;
    if (!dry.changed) return toast(t('Alle Aufgaben sind bereits so früh wie möglich terminiert'));
    const list = dry.tasks.slice(0, 8).map((x) => `• ${x.title}: ${fmtShort(x.start)} – ${fmtShort(x.end)}`).join('\n');
    if (!confirmAsk(t.plural(dry.changed, { other: '{n} Aufgaben rücken nach vorn, so früh es die Abhängigkeiten erlauben:\n\n{list}\n\nJetzt anwenden?' }, { list: `${list}${dry.changed > 8 ? '\n…' : ''}` }))) return;
    if (await act(() => api.post(`/api/pm/projects/${project.id}/auto-schedule`, {}), t('Automatisch terminiert'))) await reload();
  };
  const days = (n: number) => t.plural(n, { one: '{n} Tag', other: '{n} Tage' });
  const tip = (tk: GTask, d: { start: string; end: string }) =>
    `${tk.title}\n${fmtShort(d.start)} – ${fmtShort(d.end)} · ${days(durationOf(d, cal))}${tk.float !== null && !tk.done ? `\n${t('Puffer: {days}', { days: days(tk.float) })}${tk.critical ? t(' (kritischer Pfad)') : ''}` : ''}${tk.assignees.length ? `\n${tk.assignees.map((a) => a.name).join(', ')}` : ''}`;

  return (
    <div className="pm-ganttview" data-tour="pm-gantt">
      <div className="pm-g-bar">
        <div className="pm-seg" role="group" aria-label="Zoom" data-tour="pm-gantt-zoom">
          {(['day', 'week', 'month'] as Zoom[]).map((z) => (
            <button key={z} type="button" className={zoom === z ? 'on' : ''} aria-pressed={zoom === z} onClick={() => setZoom(z)}>
              {z === 'day' ? t('Tag') : z === 'week' ? t('Woche') : t('Monat')}
            </button>
          ))}
        </div>
        <button type="button" className="btn small secondary" onClick={() => scroller.current && (scroller.current.scrollLeft = Math.max(0, X(axis.today) - scroller.current.clientWidth / 3))}>
          {t('Heute')}
        </button>
        <label className="check pm-check-inline" data-tour="pm-gantt-crit">
          <input type="checkbox" checked={crit === 'on'} onChange={(e) => setCrit(e.target.checked ? 'on' : 'off')} /> {t('Kritischer Pfad')}
          {crit === 'on' && critCount > 0 && <span className="muted small">({critCount}{data.critical_end ? t(' · Ende {date}', { date: fmtShort(data.critical_end) }) : ''})</span>}
        </label>
        <label className="check pm-check-inline" data-tour="pm-gantt-base">
          <input type="checkbox" checked={base === 'on'} onChange={(e) => setBase(e.target.checked ? 'on' : 'off')} /> {t('Basisplan')}
        </label>
        <label className="check pm-check-inline">
          <input type="checkbox" checked={hideDone === 'on'} onChange={(e) => setHideDone(e.target.checked ? 'on' : 'off')} /> {t('Erledigte ausblenden')}
        </label>
        <span className="grow" />
        {violated > 0 && (
          <span className="badge red" title={t('Abhängigkeiten, die nicht eingehalten werden – „Automatisch planen“ löst sie auf')}>
            {violated} {violated === 1 ? t('Konflikt') : t('Konflikte')}
          </span>
        )}
        <Pop
          label={t('Basisplan verwalten')}
          width={270}
          className="btn small secondary"
          button={
            <>
              {t('Basisplan')} <span aria-hidden="true">▾</span>
            </>
          }
        >
          {(close) => (
            <div className="pm-menu">
              <button
                type="button"
                onClick={async () => {
                  close();
                  if (await act(() => api.post(`/api/pm/projects/${project.id}/baseline`, {}), t('Basisplan gesetzt'))) (setBase('on'), await reload());
                }}
              >
                {data.project.baseline_at ? t('Aktuelle Termine als neuen Basisplan festhalten') : t('Aktuelle Termine als Basisplan festhalten')}
              </button>
              {data.project.baseline_at && (
                <button
                  type="button"
                  onClick={async () => {
                    close();
                    if (confirmAsk(t('Basisplan löschen?')) && (await act(() => api.del(`/api/pm/projects/${project.id}/baseline`), t('Basisplan gelöscht')))) await reload();
                  }}
                >
                  {t('Basisplan löschen')}
                </button>
              )}
              <p className="muted small">{t('Der Basisplan hält die Termine von heute als Vergleich fest. Später verschobene Aufgaben zeigen darunter einen dünnen grauen Balken.')}</p>
            </div>
          )}
        </Pop>
        <button type="button" className="btn small secondary" onClick={autoSchedule} data-tour="pm-gantt-auto">
          <Icon name="refresh" size={13} /> {t('Automatisch planen')}
        </button>
      </div>

      <div className="pm-gantt" ref={scroller} onScroll={() => selDep && setSelDep(null)}>
        <div className="pm-g-inner" style={{ width: leftW + width }}>
          <div className="pm-g-head" style={{ height: HEAD_H }}>
            <div className="pm-g-corner" style={{ width: leftW }}>
              {t('Aufgabe')}
            </div>
            <div className="pm-g-scale" style={{ width }}>
              {head.top.map((h) => (
                <span key={`t${h.x}`} className="pm-g-top" style={{ left: h.x, width: h.w }}>
                  {h.label}
                </span>
              ))}
              {head.bottom.map((h) => (
                <span key={`b${h.x}`} className={`pm-g-bot${h.we ? ' we' : ''}${h.today ? ' today' : ''}`} style={{ left: h.x, width: h.w }}>
                  {h.label}
                  {h.sub && <small>{h.sub}</small>}
                </span>
              ))}
            </div>
          </div>
          <div className="pm-g-body">
            <div className="pm-g-left" style={{ width: leftW }}>
              {rows.map((r) =>
                r.kind === 'section' ? (
                  <div key={r.key} className="pm-g-row pm-g-sec" style={{ height: ROW_H }}>
                    <button type="button" className="pm-caret" aria-expanded={!collapsed.has(r.key)} aria-label={`${r.name} ${collapsed.has(r.key) ? t('aufklappen') : t('zuklappen')}`} onClick={() => setCollapsed((c) => (c.has(r.key) ? new Set([...c].filter((x) => x !== r.key)) : new Set([...c, r.key])))}>
                      {collapsed.has(r.key) ? '▸' : '▾'}
                    </button>
                    <strong>{r.name}</strong> <span className="muted small">{r.count}</span>
                  </div>
                ) : (
                  <div key={r.key} className={`pm-g-row${r.t.done ? ' done' : ''}${drag?.target === r.t.id ? ' target' : ''}`} style={{ height: ROW_H, paddingLeft: 8 + r.t.depth * 14 }}>
                    {r.t.has_children ? (
                      <button type="button" className="pm-caret" aria-expanded={!collapsed.has(r.t.id)} aria-label={collapsed.has(r.t.id) ? t('Unteraufgaben aufklappen') : t('Unteraufgaben zuklappen')} onClick={() => setCollapsed((c) => (c.has(r.t.id) ? new Set([...c].filter((x) => x !== r.t.id)) : new Set([...c, r.t.id])))}>
                        {collapsed.has(r.t.id) ? '▸' : '▾'}
                      </button>
                    ) : (
                      <span className="pm-caret-space" />
                    )}
                    <i className="pm-dot" style={{ background: r.t.status?.color ?? '#94a3b8' }} title={r.t.status?.name} aria-hidden="true" />
                    <button type="button" className="pm-g-name" onClick={() => openTask(r.t.id)} title={r.t.title}>
                      {r.t.milestone && '◆ '}
                      {r.t.title}
                    </button>
                    {!narrow && r.t.assignees[0] && <Avatar person={r.t.assignees[0]} size={18} />}
                    {!r.t.scheduled && (
                      <span className="muted small" title={t('Noch ohne Termin – im Diagramm einen Zeitraum aufziehen')}>
                        {t('ohne Termin')}
                      </span>
                    )}
                  </div>
                ),
              )}
              <div className="pm-g-addrow">
                <QuickAdd
                  small
                  placeholder={t('Aufgabe hinzufügen…')}
                  onAdd={async (title) => {
                    const start = axis.today;
                    if (await taskApi.create({ title, project_id: project.id, start_at: start, due_at: addDay(start, 2) })) await reload();
                  }}
                />
              </div>
            </div>

            <svg
              ref={svgRef}
              className="pm-g-svg"
              width={width}
              height={Math.max(height, 40)}
              onPointerMove={onMove}
              onPointerUp={() => void onUp()}
              onPointerCancel={() => setDrag(null)}
              role="img"
              aria-label={t('Zeitplan: Balken je Aufgabe, Pfeile für Abhängigkeiten')}
              onClick={() => setSelDep(null)}
            >
              <defs>
                <marker id="pm-ar" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
                  <path d="M0,0 L7,3.5 L0,7 z" className="pm-ar" />
                </marker>
                <marker id="pm-ar-crit" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
                  <path d="M0,0 L7,3.5 L0,7 z" className="pm-ar crit" />
                </marker>
                <marker id="pm-ar-bad" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
                  <path d="M0,0 L7,3.5 L0,7 z" className="pm-ar bad" />
                </marker>
              </defs>
              {/* rows */}
              {rows.map((r, i) => (
                <rect key={r.key} x={0} y={i * ROW_H} width={width} height={ROW_H} className={r.kind === 'section' ? 'pm-g-secband' : i % 2 ? 'pm-g-odd' : 'pm-g-even'} onPointerDown={r.kind === 'task' && !r.t.scheduled ? (e) => startDrag(e, 'draw', r.t) : undefined} />
              ))}
              {/* weekends and week lines */}
              {zoom !== 'month' &&
                Array.from({ length: axis.days }, (_, i) => addDay(axis.start, i)).map((d, i) =>
                  isWeekend(d) ? <rect key={`w${d}`} x={i * dw} y={0} width={dw} height={Math.max(height, 40)} className="pm-g-we" pointerEvents="none" /> : null,
                )}
              {Array.from({ length: axis.days }, (_, i) => i)
                .filter((i) => (zoom === 'day' ? true : new Date(`${addDay(axis.start, i)}T00:00:00Z`).getUTCDay() === 1 && zoom === 'week') || (zoom === 'month' && addDay(axis.start, i).slice(8) === '01'))
                .map((i) => (
                  <line key={`l${i}`} x1={i * dw} x2={i * dw} y1={0} y2={Math.max(height, 40)} className={`pm-g-grid${zoom === 'day' && new Date(`${addDay(axis.start, i)}T00:00:00Z`).getUTCDay() !== 1 ? ' fine' : ''}`} pointerEvents="none" />
                ))}
              {/* project window */}
              {data.project.start && <line x1={X(data.project.start)} x2={X(data.project.start)} y1={0} y2={Math.max(height, 40)} className="pm-g-proj" pointerEvents="none" />}
              {data.project.end && <line x1={X(addDay(data.project.end, 1))} x2={X(addDay(data.project.end, 1))} y1={0} y2={Math.max(height, 40)} className="pm-g-proj" pointerEvents="none" />}
              {/* today */}
              <line x1={X(axis.today) + dw / 2} x2={X(axis.today) + dw / 2} y1={0} y2={Math.max(height, 40)} className="pm-g-today" pointerEvents="none" />

              {/* dependency arrows */}
              {data.deps.map((d) => {
                const path = arrow(d);
                if (!path) return null;
                const cls = d.violated ? 'bad' : crit === 'on' && d.critical ? 'crit' : '';
                return (
                  <g key={d.id} className={`pm-g-dep ${cls}${selDep?.id === d.id ? ' sel' : ''}`}>
                    <path d={path} className="pm-g-deppath" markerEnd={`url(#${d.violated ? 'pm-ar-bad' : cls === 'crit' ? 'pm-ar-crit' : 'pm-ar'})`} />
                    <path
                      d={path}
                      className="pm-g-dephit"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        const p = local(e);
                        setSelDep({ id: d.id, x: p.x, y: p.y });
                      }}
                    >
                      <title>{`${byId.get(d.on)?.title} → ${byId.get(d.task)?.title} (${t(DEP_LABEL[d.type] ?? '')}${d.lag ? t.plural(d.lag, { other: ', {lag} Tage' }, { lag: `${d.lag > 0 ? '+' : ''}${d.lag}` }) : ''})${d.violated ? t(' – nicht eingehalten') : ''}`}</title>
                    </path>
                  </g>
                );
              })}

              {/* bars */}
              {rows.map((r, i) => {
                if (r.kind !== 'task') return null;
                const tk = r.t;
                const d = datesOf(tk);
                if (!d) return null;
                const x = X(d.start);
                const w = Math.max((diffDay(d.start, d.end) + 1) * dw, 3);
                const y = i * ROW_H + (ROW_H - BAR_H) / 2;
                const isCrit = crit === 'on' && tk.critical && !tk.done;
                const baseline = base === 'on' && tk.baseline ? tk.baseline : null;
                const cls = `pm-gbar${tk.done ? ' done' : ''}${isCrit ? ' crit' : ''}${tk.has_children ? ' parent' : ''}${drag?.id === tk.id && drag.moved ? ' dragging' : ''}`;
                const label = zoom !== 'month' ? tk.title : '';
                return (
                  <g key={tk.id} className={cls}>
                    <title>{tip(tk, d)}</title>
                    {baseline && <rect x={X(baseline.start)} y={i * ROW_H + ROW_H - 9} width={Math.max((diffDay(baseline.start, baseline.end) + 1) * dw, 3)} height={4} rx={2} className="pm-g-basebar" pointerEvents="none" />}
                    {tk.milestone ? (
                      <polygon
                        points={`${x + dw / 2},${y - 1} ${x + dw / 2 + 10},${y + BAR_H / 2} ${x + dw / 2},${y + BAR_H + 1} ${x + dw / 2 - 10},${y + BAR_H / 2}`}
                        className="pm-g-ms main"
                        onPointerDown={(e) => startDrag(e, 'move', tk)}
                      />
                    ) : tk.has_children ? (
                      <>
                        <rect x={x} y={y + 4} width={w} height={BAR_H - 8} rx={2} className="main" onPointerDown={(e) => startDrag(e, 'move', tk)} />
                        <path d={`M${x},${y + BAR_H - 4} v6 l5,-6 z M${x + w},${y + BAR_H - 4} v6 l-5,-6 z`} className="pm-g-cap" pointerEvents="none" />
                        {tk.progress > 0 && <rect x={x} y={y + 4} width={(w * tk.progress) / 100} height={BAR_H - 8} rx={2} className="prog" pointerEvents="none" />}
                      </>
                    ) : (
                      <>
                        <rect x={x} y={y} width={w} height={BAR_H} rx={4} className="main" onPointerDown={(e) => startDrag(e, 'move', tk)} />
                        {tk.progress > 0 && <rect x={x} y={y} width={(w * tk.progress) / 100} height={BAR_H} rx={4} className="prog" pointerEvents="none" />}
                        {w > 14 && <rect x={x} y={y} width={7} height={BAR_H} className="pm-g-handle" onPointerDown={(e) => startDrag(e, 'start', tk)} />}
                        {w > 14 && <rect x={x + w - 7} y={y} width={7} height={BAR_H} className="pm-g-handle" onPointerDown={(e) => startDrag(e, 'end', tk)} />}
                      </>
                    )}
                    {label && (
                      <text x={x + (tk.milestone ? dw / 2 + 28 : w + 24)} y={y + BAR_H / 2 + 4} className="pm-g-label" pointerEvents="none">
                        {label.length > 38 ? `${label.slice(0, 37)}…` : label}
                      </text>
                    )}
                    {/* connector: drag from here onto another task so it waits for this one */}
                    {!tk.milestone && (
                      <circle cx={x + w + 11} cy={y + BAR_H / 2} r={5} className="pm-g-conn" onPointerDown={(e) => startDrag(e, 'link', tk)}>
                        <title>{t('Ziehen, um eine Abhängigkeit anzulegen (die andere Aufgabe wartet auf diese)')}</title>
                      </circle>
                    )}
                    {tk.milestone && <circle cx={x + dw / 2 + 17} cy={y + BAR_H / 2} r={5} className="pm-g-conn" onPointerDown={(e) => startDrag(e, 'link', tk)} />}
                  </g>
                );
              })}

              {/* live feedback while dragging */}
              {drag && drag.moved && drag.cur && drag.kind !== 'link' && (
                <g pointerEvents="none">
                  <rect x={X(drag.cur.start)} y={0} width={(diffDay(drag.cur.start, drag.cur.end) + 1) * dw} height={Math.max(height, 40)} className="pm-g-ghost" />
                  <text x={Math.min(X(drag.cur.start), width - 150)} y={14} className="pm-g-tip">
                    {fmtShort(drag.cur.start)} – {fmtShort(drag.cur.end)} · {days(durationOf(drag.cur, cal))}
                  </text>
                </g>
              )}
              {drag && drag.kind === 'link' && drag.moved && (() => {
                const src = byId.get(drag.id);
                const e = src ? edge(src, 'F') : null;
                return e ? <line x1={e.x} y1={e.y} x2={drag.px} y2={drag.py} className="pm-g-linkline" pointerEvents="none" /> : null;
              })()}
            </svg>
            {selDep && selDepRow && (
              <div className="pm-g-depbox" style={{ left: leftW + Math.min(selDep.x, width - 250), top: Math.min(selDep.y + 8, height) }} role="dialog" aria-label={t('Abhängigkeit')} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setSelDep(null))}>
                <div className="pm-g-depbox-head">
                  <strong>
                    {byId.get(selDepRow.on)?.title} → {byId.get(selDepRow.task)?.title}
                  </strong>
                  <button type="button" className="icon-btn" aria-label={t('Schließen')} onClick={() => setSelDep(null)}>
                    ✕
                  </button>
                </div>
                <div className="pm-g-depbox-row">
                  <select
                    value={selDepRow.type}
                    aria-label={t('Art')}
                    onChange={async (e) => {
                      if (await act(() => api.patch(`/api/pm/dependencies/${selDepRow.id}`, { type: e.target.value }))) await reload();
                    }}
                  >
                    {Object.entries(DEP_LABEL).map(([k, l]) => (
                      <option key={k} value={k}>
                        {t(l)}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    defaultValue={selDepRow.lag}
                    aria-label={t('Versatz in Tagen')}
                    title={t('Versatz in Tagen (negativ = Überlappung)')}
                    onBlur={async (e) => {
                      const lag = Number(e.target.value) || 0;
                      if (lag !== selDepRow.lag && (await act(() => api.patch(`/api/pm/dependencies/${selDepRow.id}`, { lag })))) await reload();
                    }}
                  />
                  <span className="muted small">{t('Tage')}</span>
                </div>
                {selDepRow.violated && <p className="small pm-bad">{t('Wird nicht eingehalten – „Automatisch planen“ schiebt die Folgeaufgabe.')}</p>}
                <button
                  type="button"
                  className="btn small danger"
                  onClick={async () => {
                    if (await act(() => api.del(`/api/pm/dependencies/${selDepRow.id}`), t('Abhängigkeit gelöst'))) (setSelDep(null), await reload());
                  }}
                >
                  {t('Abhängigkeit lösen')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="pm-g-legend" aria-label={t('Legende')}>
        <span><i className="lg bar" /> {t('Aufgabe')}</span>
        <span><i className="lg done" /> {t('Erledigt')}</span>
        <span><i className="lg crit" /> {t('Kritischer Pfad')}</span>
        <span><i className="lg ms" /> {t('Meilenstein')}</span>
        <span><i className="lg base" /> {t('Basisplan')}</span>
        <span className="muted small">{t('Balken ziehen = verschieben · Rand ziehen = Dauer · Punkt am Ende auf eine andere Aufgabe ziehen = Abhängigkeit · Folgeaufgaben rücken automatisch nach')}</span>
      </div>
    </div>
  );
}

