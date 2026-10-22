import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { Check, Empty, Spinner, act, navigate, toast, toastError, useLoad } from '../ui';
import { fmtDate, useT } from '../i18n';
import { can, useSession } from '../session';
import { AgendaList, MonthGrid, TimeGrid, type Column, type DayBucket, type Drop } from './CalendarGrid';
import { ApptDrawer, BookDialog, ConflictDialog, ScopeDialog, STATUS, type Scope, type Slot } from './CalendarDrawer';
import { addDays, hm, hourRange, multiDay, onDay, rangeOf, shift, taskDue, todayIn, wall, zoned, type Appt, type Cal, type Issue, type TaskItem, type View, type ViewData } from './calview-model';
import './calview.css';

/**
 * Kalenderansicht (docs/booking.md#calendar-view): day, week, month, team (a column per person) and agenda (phones). Drag to move
 * and resize, click an empty slot to book, click an appointment for the drawer. Overlays: bookable hours, buffers, blocked times,
 * busy times of connected calendars, absences, and tasks with a due date as a second layer. Times are the sub-account's zone.
 */

const KEY = 'pghl.calview';
interface Prefs {
  view: View;
  calendars: string[];
  users: string[];
  statuses: string[];
  tasks: boolean;
  busy: boolean;
  absences: boolean;
  buffers: boolean;
}
const DEFAULTS: Prefs = { view: 'week', calendars: [], users: [], statuses: ['confirmed', 'showed', 'noshow', 'blocked'], tasks: false, busy: true, absences: true, buffers: true };
const loadPrefs = (): Prefs => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
};
const phone = () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 700px)').matches;

type Pending = { kind: 'conflict'; appt: Appt; start: string; end: string; issues: Issue[] } | { kind: 'scope'; appt: Appt; start: string; end: string; sameDay: boolean };

export function CalendarView({ calendars: initialCals }: { calendars?: Cal[] }) {
  const t = useT('calview');
  const session = useSession();
  const tz = session.locations.find((l) => l.id === session.locationId)?.timezone || 'Europe/Berlin';
  const [prefs, setPrefsState] = useState<Prefs>(() => {
    const p = loadPrefs();
    return phone() && (p.view === 'week' || p.view === 'team') ? { ...p, view: 'agenda' } : p;
  });
  const setPrefs = (p: Partial<Prefs>) =>
    setPrefsState((cur) => {
      const next = { ...cur, ...p };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* private mode: the view still works, it just forgets */
      }
      return next;
    });
  const [anchor, setAnchor] = useState(() => todayIn(tz));
  const [open, setOpen] = useState<string | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [filters, setFilters] = useState(false);
  const [help, setHelp] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const view = prefs.view;
  const range = useMemo(() => rangeOf(view, anchor, tz), [view, anchor, tz]);
  const mayTasks = can(session, 'contacts');

  const query = new URLSearchParams({ from: range.from, to: range.to, layers: [prefs.busy && 'busy', prefs.absences && 'absences'].filter(Boolean).join(',') });
  if (prefs.calendars.length) query.set('calendars', prefs.calendars.join(','));
  if (prefs.users.length) query.set('users', prefs.users.join(','));
  if (prefs.statuses.length) query.set('status', prefs.statuses.join(','));
  const data = useLoad(() => api.get<ViewData>(`/api/calendar-view?${query}`), [query.toString()]);
  const tasks = useLoad<TaskItem[]>(
    () =>
      prefs.tasks && mayTasks
        ? api
            .get<any>(`/api/pm/tasks?from=${range.days[0]}&to=${range.days[range.days.length - 1]}&has_dates=1&limit=500`)
            .then((r) => (Array.isArray(r) ? r : (r?.tasks ?? r?.items ?? [])))
            .catch(() => api.get<any[]>('/api/tasks?status=all'))
        : Promise.resolve([]),
    [prefs.tasks, range.from, range.to],
  );
  const v = data.data;
  const cals: Cal[] = v?.calendars ?? initialCals ?? [];
  const calById = useMemo(() => new Map(cals.map((c) => [c.id, c])), [cals]);
  const colorOf = (a: Appt) => calById.get(a.calendar_id)?.color ?? '#2563eb';
  const shownCals = prefs.calendars.length ? cals.filter((c) => prefs.calendars.includes(c.id)) : cals;
  const userName = useMemo(() => new Map((v?.users ?? []).map((u) => [u.id, u.name])), [v]);
  const today = todayIn(tz);
  const nowW = wall(Date.now(), tz);
  const openTask = (_id: string) => navigate('tasks');

  // --- per day buckets (month, agenda, all-day row) ---------------------------------------------------------------------------------
  const taskItems = (tasks.data ?? []).filter((x) => !prefs.users.length || (x.assigned_to && prefs.users.includes(x.assigned_to)) || (x.assignees ?? []).some((u) => prefs.users.includes(u)));
  const byDay = useMemo(() => {
    const m = new Map<string, DayBucket>();
    const get = (d: string) => m.get(d) ?? (m.set(d, { appts: [], tasks: [], absences: [] }), m.get(d)!);
    for (const a of v?.appointments ?? []) {
      for (const d of range.days) if (onDay(a.start_at, a.end_at, d, tz)) get(d).appts.push(a);
    }
    if (prefs.tasks)
      for (const x of taskItems) {
        const due = taskDue(x, tz);
        if (due && range.days.includes(due.ymd)) get(due.ymd).tasks.push({ id: x.id, title: x.title, done: !!x.done, min: due.min });
      }
    if (prefs.absences)
      for (const ab of v?.absences ?? [])
        for (const d of range.days) {
          const s = onDay(ab.start_at, ab.end_at, d, tz);
          if (s && s.to - s.from >= 12 * 60) get(d).absences.push({ key: `${ab.user_id}-${ab.start_at}-${d}`, label: `${userName.get(ab.user_id) ?? ''}: ${ab.note || t('abwesend')}` });
        }
    return m;
  }, [v, tasks.data, prefs.tasks, prefs.absences, range, tz]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- columns of the time grid -------------------------------------------------------------------------------------------------------
  const columns: Column[] = useMemo(() => {
    if (!v || (view !== 'day' && view !== 'week' && view !== 'team')) return [];
    const openOf = (d: string, calIds: string[]) => calIds.flatMap((cid) => (v.hours[cid] ?? []).map((h) => onDay(h.start_at, h.end_at, d, tz)).filter((x): x is { from: number; to: number } => !!x));
    const base = (key: string, d: string, label: string, sub: string | undefined, person: string | null | undefined, appts: Appt[], calIds: string[]): Column => {
      const items = appts.flatMap((a) => {
        if (multiDay(a.start_at, a.end_at, tz)) return [];
        const s = onDay(a.start_at, a.end_at, d, tz);
        return s ? [{ appt: a, ...s, cutTop: Date.parse(a.start_at) < Date.parse(zoned(d, 0, tz)), cutBottom: Date.parse(a.end_at) > Date.parse(zoned(addDays(d, 1), 0, tz)) }] : [];
      });
      const ids = new Set(appts.map((a) => a.id));
      const buffers = prefs.buffers ? v.buffers.filter((b) => ids.has(b.appointment_id)).flatMap((b) => onDay(b.start_at, b.end_at, d, tz) ?? []) : [];
      const busy = prefs.busy
        ? v.busy
            .filter((b) => (person !== undefined ? b.user_id === person : !!b.calendar_id && calIds.includes(b.calendar_id)))
            .flatMap((b) => {
              const s = onDay(b.start_at, b.end_at, d, tz);
              return s ? [{ ...s, label: t('Belegt im verbundenen Kalender') }] : [];
            })
        : [];
      const absences =
        prefs.absences && person
          ? v.absences
              .filter((x) => x.user_id === person)
              .flatMap((x) => {
                const s = onDay(x.start_at, x.end_at, d, tz);
                return s && s.to - s.from < 12 * 60 ? [{ ...s, label: x.note || t('abwesend') }] : [];
              })
          : [];
      const dayTasks = prefs.tasks ? taskItems.filter((x) => person === undefined || person === null || x.assigned_to === person) : [];
      const timed = dayTasks.flatMap((x) => {
        const due = taskDue(x, tz);
        return due && due.ymd === d && due.min !== null ? [{ id: x.id, min: due.min, title: x.title, done: !!x.done }] : [];
      });
      const allDay: Column['allDay'] = [
        ...appts
          .filter((a) => multiDay(a.start_at, a.end_at, tz) && onDay(a.start_at, a.end_at, d, tz))
          .map((a) => ({ key: `m${a.id}`, label: a.title, kind: 'item' as const, color: colorOf(a), done: a.status === 'cancelled', onClick: () => setOpen(a.id) })),
        ...dayTasks.flatMap((x) => {
          const due = taskDue(x, tz);
          return due && due.ymd === d && due.min === null ? [{ key: `t${x.id}`, label: `${x.done ? '☑' : '☐'} ${x.title}`, kind: 'task' as const, done: !!x.done, onClick: () => openTask(x.id) }] : [];
        }),
        ...(prefs.absences
          ? v.absences
              .filter((x) => (person !== undefined ? x.user_id === person : true))
              .flatMap((x) => {
                const s = onDay(x.start_at, x.end_at, d, tz);
                return s && s.to - s.from >= 12 * 60
                  ? [
                      {
                        key: `a${x.user_id}${x.start_at}`,
                        label: person !== undefined ? x.note || t('abwesend') : `${userName.get(x.user_id) ?? ''}: ${x.note || t('abwesend')}`,
                        kind: 'absence' as const,
                      },
                    ]
                  : [];
              })
          : []),
      ];
      return { key, ymd: d, label, sub, personId: person, today: d === today, items, open: openOf(d, calIds), buffers, busy, absences, tasks: timed, allDay };
    };
    const dayLabel = (d: string) => fmtDate(`${d}T12:00:00Z`, { weekday: 'short', day: 'numeric', month: view === 'day' ? 'long' : 'numeric', timeZone: 'UTC' });
    const calIds = shownCals.map((c) => c.id);
    if (view === 'team') {
      const d = range.days[0];
      const people = (prefs.users.length ? v.users.filter((u) => prefs.users.includes(u.id)) : v.users).slice(0, 12);
      const cols = people.map((u) =>
        base(
          u.id,
          d,
          u.name,
          undefined,
          u.id,
          v.appointments.filter((a) => a.people.includes(u.id)),
          calIds.filter((cid) => {
            const m = calById.get(cid)?.members ?? [];
            return !m.length || m.includes(u.id);
          }),
        ),
      );
      const loose = v.appointments.filter((a) => !a.people.length);
      if (loose.length || !cols.length) cols.push(base('none', d, t('Ohne Person'), undefined, null, loose, calIds));
      return cols;
    }
    return range.days.map((d) => base(d, d, dayLabel(d), undefined, undefined, v.appointments, calIds));
  }, [v, view, range, prefs, tasks.data, tz]); // eslint-disable-line react-hooks/exhaustive-deps
  const hours = hourRange(columns.flatMap((c) => [...c.items, ...c.open, ...c.tasks.map((x) => ({ from: x.min, to: x.min + 15 }))]));

  // --- moving ----------------------------------------------------------------------------------------------------------------------
  const move = async (a: Appt, start: string, end: string, force = false) => {
    try {
      const r = await api.post<any>(`/api/calendar-view/appointments/${a.id}/move`, { start, end, force });
      toast(r.notified ? t('Verschoben – der Kontakt wurde informiert') : t('Verschoben'));
      data.reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data?.issues) setPending({ kind: 'conflict', appt: a, start, end, issues: e.data.issues });
      else toastError(e);
    }
  };
  const moveTo = (a: Appt, start: string, end: string) => {
    if (a.status === 'cancelled') return toastError(new Error(t('Abgesagte Termine lassen sich nicht verschieben')));
    if (a.series_id) return setPending({ kind: 'scope', appt: a, start, end, sameDay: wall(start, tz).ymd === wall(a.start_at, tz).ymd });
    void move(a, start, end);
  };
  const scoped = async (p: Extract<Pending, { kind: 'scope' }>, scope: Scope) => {
    setPending(null);
    if (scope === 'single') return move(p.appt, p.start, p.end);
    const w = wall(p.start, tz);
    const minutes = Math.round((Date.parse(p.end) - Date.parse(p.start)) / 60000);
    if (await act(() => api.patch(`/api/appointment-series/${p.appt.series_id}`, { scope, appointment_id: p.appt.id, start_time: hm(w.min), duration: minutes }), t('Serie geändert'))) data.reload();
  };
  const onDrop = (d: Drop) => {
    const col = columns[d.col];
    if (!col) return;
    moveTo(d.appt, zoned(col.ymd, d.from, tz), zoned(col.ymd, d.to, tz));
  };
  const onKeyMove = (a: Appt, _col: number, kind: 'move' | 'resize' | 'day', delta: number) => {
    const s = Date.parse(a.start_at);
    const e = Date.parse(a.end_at);
    if (kind === 'resize') return moveTo(a, a.start_at, new Date(Math.max(s + 15 * 60_000, e + delta * 60_000)).toISOString());
    if (kind === 'day') {
      const ws = wall(s, tz);
      const start = zoned(addDays(ws.ymd, delta), ws.min, tz);
      return moveTo(a, start, new Date(Date.parse(start) + e - s).toISOString());
    }
    moveTo(a, new Date(s + delta * 60_000).toISOString(), new Date(e + delta * 60_000).toISOString());
  };
  const moveDay = (a: Appt, ymd: string) => {
    const ws = wall(a.start_at, tz);
    if (ws.ymd === ymd) return;
    const start = zoned(ymd, ws.min, tz);
    moveTo(a, start, new Date(Date.parse(start) + Date.parse(a.end_at) - Date.parse(a.start_at)).toISOString());
  };
  const book = (ymd: string, min: number) => {
    if (!cals.length) return toastError(new Error(t('Lege zuerst einen Kalender an')));
    setSlot({ ymd, min, calendarId: shownCals[0]?.id ?? cals[0].id });
  };

  // --- keyboard -----------------------------------------------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (open || slot || pending || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable="true"], .modal')) return;
      if (!box.current?.isConnected) return;
      const k = e.key;
      const views: Record<string, View> = { d: 'day', w: 'week', m: 'month', p: 'team', a: 'agenda' };
      if (k === 'ArrowLeft' && !el.closest('.cv-ev')) setAnchor((x) => shift(view, x, -1));
      else if (k === 'ArrowRight' && !el.closest('.cv-ev')) setAnchor((x) => shift(view, x, 1));
      else if (k === 't') setAnchor(todayIn(tz));
      else if (views[k]) setPrefs({ view: views[k] });
      else if (k === 'n') book(view === 'month' || view === 'agenda' ? anchor : anchor, Math.min(23 * 60, (Math.floor(nowW.min / 60) + 1) * 60));
      else if (k === '?') setHelp((h) => !h);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const title =
    view === 'month'
      ? fmtDate(`${anchor.slice(0, 7)}-15T12:00:00Z`, { month: 'long', year: 'numeric', timeZone: 'UTC' })
      : view === 'week' || view === 'agenda'
        ? `${fmtDate(`${range.days[0]}T12:00:00Z`, { day: 'numeric', month: 'short', timeZone: 'UTC' })} – ${fmtDate(`${range.days[range.days.length - 1]}T12:00:00Z`, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`
        : fmtDate(`${anchor}T12:00:00Z`, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const VIEW_LABEL: Record<View, string> = { day: t('Tag'), week: t('Woche'), month: t('Monat'), team: t('Team'), agenda: t('Agenda') };

  return (
    <div className="cv" ref={box} data-presence-surface="calendar-view">
      <div className="cv-bar">
        <div className="cv-nav">
          <button type="button" className="btn small secondary" onClick={() => setAnchor(todayIn(tz))} data-tour="calview-today">
            {t('Heute')}
          </button>
          <button type="button" className="icon-btn" onClick={() => setAnchor(shift(view, anchor, -1))} aria-label={t('Zurück')}>
            ‹
          </button>
          <button type="button" className="icon-btn" onClick={() => setAnchor(shift(view, anchor, 1))} aria-label={t('Weiter')}>
            ›
          </button>
          <h2 className="cv-title" aria-live="polite">
            {title}
          </h2>
        </div>
        <div className="cv-views" role="group" aria-label={t('Ansicht')} data-tour="calview-views">
          {(['day', 'week', 'month', 'team', 'agenda'] as View[]).map((x) => (
            <button key={x} type="button" className={`cv-vbtn v-${x}${view === x ? ' on' : ''}`} aria-pressed={view === x} onClick={() => setPrefs({ view: x })}>
              {VIEW_LABEL[x]}
            </button>
          ))}
        </div>
        <div className="cv-actions">
          <button type="button" className={`btn small secondary${filters ? ' on' : ''}`} aria-expanded={filters} onClick={() => setFilters(!filters)} data-tour="calview-filters">
            {t('Filter & Ebenen')}
            {prefs.calendars.length + prefs.users.length ? ` (${prefs.calendars.length + prefs.users.length})` : ''}
          </button>
          <button
            type="button"
            className="btn small"
            onClick={() => book(view === 'month' ? (anchor.slice(0, 7) === today.slice(0, 7) ? today : anchor) : anchor, Math.min(23 * 60, (Math.floor(nowW.min / 60) + 1) * 60))}
            data-tour="calview-book"
          >
            + {t('Termin')}
          </button>
          <button type="button" className="icon-btn" onClick={() => setHelp(!help)} aria-label={t('Tastenkürzel')} aria-expanded={help}>
            ?
          </button>
        </div>
      </div>
      {help && (
        <p className="cv-help muted small">
          {t(
            'Tastatur: ← → blättern · T heute · D Tag · W Woche · M Monat · P Team · A Agenda · N neuer Termin · Tab zu einem Termin, Enter öffnet, Alt+↑/↓ verschiebt um 15 Minuten, Alt+Umschalt+↑/↓ ändert die Länge, Alt+←/→ verschiebt um einen Tag',
          )}
        </p>
      )}
      {filters && (
        <div className="cv-filters">
          <fieldset>
            <legend>{t('Kalender')}</legend>
            {cals.map((c) => (
              <label key={c.id} className="cv-fchip" style={{ ['--ev' as string]: c.color } as React.CSSProperties}>
                <input
                  type="checkbox"
                  checked={!prefs.calendars.length || prefs.calendars.includes(c.id)}
                  onChange={() =>
                    setPrefs({
                      calendars:
                        toggle(prefs.calendars.length ? prefs.calendars : cals.map((x) => x.id), c.id).length === cals.length
                          ? []
                          : toggle(prefs.calendars.length ? prefs.calendars : cals.map((x) => x.id), c.id),
                    })
                  }
                />
                <span>{c.name}</span>
              </label>
            ))}
          </fieldset>
          {(v?.users.length ?? 0) > 1 && (
            <fieldset>
              <legend>{t('Personen')}</legend>
              {v!.users.map((u) => (
                <label key={u.id} className="cv-fchip">
                  <input type="checkbox" checked={prefs.users.includes(u.id)} onChange={() => setPrefs({ users: toggle(prefs.users, u.id) })} />
                  <span>{u.name}</span>
                </label>
              ))}
            </fieldset>
          )}
          <fieldset>
            <legend>{t('Status')}</legend>
            {Object.entries(STATUS).map(([k, [label]]) => (
              <label key={k} className="cv-fchip">
                <input type="checkbox" checked={prefs.statuses.includes(k)} onChange={() => setPrefs({ statuses: toggle(prefs.statuses, k) })} />
                <span>{t(label)}</span>
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>{t('Ebenen')}</legend>
            {mayTasks && <Check checked={prefs.tasks} onChange={(x) => setPrefs({ tasks: x })} label={t('Aufgaben mit Fälligkeit')} />}
            <Check checked={prefs.busy} onChange={(x) => setPrefs({ busy: x })} label={t('Belegt (Google/Outlook/iCal)')} />
            <Check checked={prefs.absences} onChange={(x) => setPrefs({ absences: x })} label={t('Abwesenheiten')} />
            <Check checked={prefs.buffers} onChange={(x) => setPrefs({ buffers: x })} label={t('Puffer')} />
          </fieldset>
        </div>
      )}
      {browserTz !== tz && <p className="muted small cv-tz">{t('Zeiten in der Zeitzone des Sub-Accounts: {tz}', { tz })}</p>}
      {!v && data.loading ? (
        <Spinner />
      ) : data.error && !v ? (
        <p className="cv-warn">{data.error}</p>
      ) : !cals.length ? (
        <Empty>{t('Noch kein Kalender – lege unter „Kalender“ einen an.')}</Empty>
      ) : view === 'month' ? (
        <MonthGrid
          days={range.days}
          month={anchor.slice(0, 7)}
          today={today}
          tz={tz}
          byDay={byDay}
          colorOf={colorOf}
          onDay={(d) => (setAnchor(d), setPrefs({ view: 'day' }))}
          onSlot={(d) => book(d, 9 * 60)}
          onOpen={(a) => setOpen(a.id)}
          onMoveDay={moveDay}
          openTask={openTask}
        />
      ) : view === 'agenda' ? (
        <AgendaList
          days={range.days}
          tz={tz}
          today={today}
          byDay={byDay}
          colorOf={colorOf}
          onOpen={(a) => setOpen(a.id)}
          onSlot={(d) => book(d, d === today ? Math.min(23 * 60, (Math.floor(nowW.min / 60) + 1) * 60) : 9 * 60)}
          openTask={openTask}
        />
      ) : (
        <TimeGrid
          columns={columns}
          hours={hours}
          nowMin={range.days.includes(today) ? nowW.min : null}
          colorOf={colorOf}
          lockColumns={view === 'team'}
          onSlot={(ci, min) => book(columns[ci].ymd, min)}
          onOpen={(a) => setOpen(a.id)}
          onDrop={onDrop}
          onKeyMove={onKeyMove}
          openTask={openTask}
        />
      )}
      <button type="button" className="cv-fab" onClick={() => book(anchor < today ? today : anchor, Math.min(23 * 60, (Math.floor(nowW.min / 60) + 1) * 60))} aria-label={t('Termin eintragen')}>
        +
      </button>
      {open && <ApptDrawer id={open} tz={tz} teamCancel onClose={() => setOpen(null)} onChanged={data.reload} />}
      {slot && <BookDialog slot={slot} calendars={cals.filter((c) => c.active)} tz={tz} onClose={() => setSlot(null)} onDone={() => (setSlot(null), data.reload())} />}
      {pending?.kind === 'conflict' && (
        <ConflictDialog
          issues={pending.issues}
          title={t('Trotzdem verschieben?')}
          confirm={t('Trotzdem verschieben')}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const p = pending;
            setPending(null);
            void move(p.appt, p.start, p.end, true);
          }}
        />
      )}
      {pending?.kind === 'scope' && <ScopeDialog title={t('Termin verschieben')} allowWide={pending.sameDay} onCancel={() => setPending(null)} onPick={(s) => scoped(pending, s)} />}
    </div>
  );
}
