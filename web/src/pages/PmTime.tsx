import { useEffect, useState } from 'react';
import { api, money } from '../api';
import { Icon } from '../icons';
import { Badge, Empty, Field, Link, Modal, PageHead, Spinner, act, confirmAsk, navigate, toast, useLoad } from '../ui';
import { can, useSession } from '../session';
import {
  Avatar,
  PeoplePicker,
  ProjectDot,
  addDay,
  centsToEuros,
  eurosToCents,
  fmtHM,
  fmtHMS,
  fmtHours,
  fmtShort,
  fmtWd,
  mondayOf,
  parseDuration,
  refreshMeta,
  timeOf,
  todayIn,
  useTick,
  usePmMeta,
  zonedIso,
  type Meta,
  type Project,
  type Task,
} from './PmKit';
import { useT } from '../i18n';
import { SortableGrid } from '../sortable/Sortable';

/** Time tracking: timer and entries, weekly timesheet with approval, reports, billing and settings. */

interface Entry {
  id: string;
  user_id: string;
  user_name: string;
  task_id: string | null;
  task_title: string;
  project_id: string | null;
  project_name: string;
  project_color: string;
  started_at: string;
  ended_at: string | null;
  seconds: number;
  has_clock: boolean;
  note: string;
  billable: boolean;
  running: boolean;
  approval: string;
  day: string;
  invoice_number: string | null;
  auto_stopped: boolean;
}

export function PmTime({ tab = '' }: { tab?: string }) {
  const t = useT('pm');
  const meta = usePmMeta();
  const session = useSession();
  const payments = can(session, 'payments');
  const manager = !!meta?.me.manager;
  const cur = tab === 'week' || tab === 'reports' || (tab === 'billing' && payments) || (tab === 'settings' && manager) ? tab : '';
  const on = (k: string) => (cur === k ? 'on' : '');
  return (
    <>
      <PageHead title={t('Zeiterfassung')} sub={t('Timer, Wochenzettel, Berichte und Abrechnung – direkt an Aufgaben und Projekten.')}>
        <Link to="pm" className="btn secondary">
          <Icon name="kanban" size={14} /> {t('Projektplanung')}
        </Link>
      </PageHead>
      <nav className="tabs pm-time-tabs" aria-label={t('Zeiterfassung')}>
        <Link to="time" className={on('')} tour="pm-time-tab-timer">
          {t('Erfassen')}
        </Link>
        <Link to="time/week" className={on('week')} tour="pm-time-tab-week">
          {t('Wochenzettel')}
        </Link>
        <Link to="time/reports" className={on('reports')} tour="pm-time-tab-reports">
          {t('Berichte')}
        </Link>
        {payments && (
          <Link to="time/billing" className={on('billing')} tour="pm-time-tab-billing">
            {t('Abrechnung')}
          </Link>
        )}
        {manager && (
          <Link to="time/settings" className={on('settings')} tour="pm-time-tab-settings">
            {t('Einstellungen')}
          </Link>
        )}
      </nav>
      {!meta ? (
        <Spinner />
      ) : cur === '' ? (
        <TimerTab meta={meta} />
      ) : cur === 'week' ? (
        <WeekTab meta={meta} />
      ) : cur === 'reports' ? (
        <ReportsTab meta={meta} />
      ) : cur === 'billing' ? (
        <BillingTab meta={meta} />
      ) : (
        <SettingsTab meta={meta} payments={payments} />
      )}
    </>
  );
}

const bump = () => window.dispatchEvent(new Event('pm:timer'));

// --- timer and entries -------------------------------------------------------------------------------------------------

interface Running extends Entry {
  location_id: string;
  location_name: string;
  other_location: boolean;
}

function TargetPicker({ projects, project, task, onProject, onTask }: { projects: Project[]; project: string; task: string; onProject: (id: string) => void; onTask: (id: string) => void }) {
  const t = useT('pm');
  const tasks = useLoad(() => (project ? api.get<{ tasks: Task[] }>(`/api/pm/tasks?project_id=${project}&done=open&limit=300&sort=title`) : Promise.resolve({ tasks: [] as Task[] })), [project]);
  return (
    <>
      <select value={project} onChange={(e) => (onProject(e.target.value), onTask(''))} aria-label={t('Projekt')}>
        <option value="">{t('Projekt wählen…')}</option>
        {projects
          .filter((p) => p.status !== 'archived')
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
      </select>
      <select value={task} onChange={(e) => onTask(e.target.value)} aria-label={t('Aufgabe')} disabled={!project}>
        <option value="">{t('Ohne Aufgabe (nur Projekt)')}</option>
        {(tasks.data?.tasks ?? []).map((tk) => (
          <option key={tk.id} value={tk.id}>
            {tk.parent_id ? '↳ ' : ''}
            {tk.title}
          </option>
        ))}
      </select>
    </>
  );
}

function TimerTab({ meta }: { meta: Meta }) {
  const t = useT('pm');
  const tz = meta.timezone;
  const today = todayIn(tz);
  const timer = useLoad(() => api.get<{ running: Running | null; today_seconds: number }>('/api/pm/timer'), []);
  const projects = useLoad(() => api.get<Project[]>('/api/pm/projects?status=all'), []);
  const [from] = useState(addDay(today, -13));
  const [scope, setScope] = useState<'me' | 'all'>('me');
  const entries = useLoad(() => api.get<{ entries: Entry[] }>(`/api/pm/time?from=${from}&to=${today}&user_id=${scope}&limit=500`), [scope]);
  const [project, setProject] = useState('');
  const [task, setTask] = useState('');
  const [note, setNote] = useState('');
  const [manual, setManual] = useState(false);
  useTick(1000);
  useEffect(() => {
    const on = () => (timer.reload(), entries.reload());
    window.addEventListener('pm:timer', on);
    return () => window.removeEventListener('pm:timer', on);
  });
  const run = timer.data?.running;
  const reloadAll = () => (timer.reload(), entries.reload(), bump());
  const elapsed = run ? (Date.now() - Date.parse(run.started_at)) / 1000 : 0;
  const byDay = new Map<string, Entry[]>();
  for (const e of entries.data?.entries ?? []) byDay.set(e.day, [...(byDay.get(e.day) ?? []), e]);
  const days = [...byDay.keys()].sort().reverse();
  return (
    <div className="pm-timertab">
      <section className="card pm-timer-card" data-tour="pm-timer-card">
        {run ? (
          <div className="pm-timer-run">
            <div>
              <div className="pm-timer-clock" aria-live="off">
                {fmtHMS(elapsed)}
              </div>
              <div>
                <strong>{run.task_title || run.project_name || t('Zeiterfassung')}</strong> {run.project_name && run.task_title && <span className="muted">· {run.project_name}</span>}
                {run.other_location && <span className="badge yellow"> in {run.location_name}</span>}
              </div>
              <input className="pm-timer-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('Notiz zur Zeit (optional)')} aria-label={t('Notiz')} />
            </div>
            <button
              type="button"
              className="btn danger pm-timer-btn"
              data-tour="pm-timer-stop"
              onClick={async () => {
                const r = await act(() => api.post<{ discarded?: boolean }>('/api/pm/timer/stop', { note: note || undefined }));
                if (r?.discarded) toast(t('Unter einer Sekunde – nicht gespeichert'));
                if (r) (setNote(''), reloadAll());
              }}
            >
              <Icon name="end" size={16} /> {t('Stoppen')}
            </button>
          </div>
        ) : (
          <div className="pm-timer-start">
            <div className="pm-timer-pick" data-tour="pm-timer-pick">
              <TargetPicker projects={projects.data ?? []} project={project} task={task} onProject={setProject} onTask={setTask} />
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('Notiz (optional)')} aria-label={t('Notiz')} />
            </div>
            <button
              type="button"
              className="btn pm-timer-btn"
              disabled={!project && !task}
              data-tour="pm-timer-start"
              onClick={async () => {
                const r = await act(() => api.post<{ stopped?: Entry }>('/api/pm/timer/start', { project_id: project || undefined, task_id: task || undefined, note: note || undefined }));
                if (r) (setNote(''), reloadAll());
              }}
            >
              <Icon name="play" size={16} /> {t('Starten')}
            </button>
          </div>
        )}
        <p className="muted small">
          {t('Heute erfasst:')} <strong>{fmtHM((timer.data?.today_seconds ?? 0) + (run && !run.other_location ? 0 : 0))} {t('Std.')}</strong> {t('· Es läuft immer nur ein Timer pro Person – ein neuer stoppt den alten.')}
        </p>
      </section>

      <div className="pm-bar">
        <h2 className="pm-h2">{t('Letzte zwei Wochen')}</h2>
        <span className="grow" />
        {meta.me.manager && (
          <div className="pm-seg" role="group" aria-label={t('Wessen Zeiten')}>
            <button type="button" className={scope === 'me' ? 'on' : ''} aria-pressed={scope === 'me'} onClick={() => setScope('me')}>
              {t('Meine')}
            </button>
            <button type="button" className={scope === 'all' ? 'on' : ''} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
              {t('Alle')}
            </button>
          </div>
        )}
        <button type="button" className="btn small" onClick={() => setManual(true)} data-tour="pm-manual-entry">
          {t('+ Zeit nachtragen')}
        </button>
      </div>
      {entries.loading && !entries.data ? (
        <Spinner />
      ) : !days.length ? (
        <Empty>{t('Noch keine Zeiten. Starte den Timer oder trage Zeit nach.')}</Empty>
      ) : (
        days.map((d) => {
          const list = byDay.get(d)!;
          return (
            <section key={d} className="card pm-day">
              <h3>
                {d === today ? t('Heute') : fmtWd(d)} <span className="muted small">{fmtHM(list.reduce((s, e) => s + e.seconds, 0))} {t('Std.')}</span>
              </h3>
              {list.map((e) => (
                <EntryRow key={e.id} e={e} tz={tz} showUser={scope === 'all'} onChange={reloadAll} />
              ))}
            </section>
          );
        })
      )}
      {manual && <ManualEntry meta={meta} projects={projects.data ?? []} onClose={() => setManual(false)} onSaved={() => (setManual(false), reloadAll())} />}
    </div>
  );
}

function EntryRow({ e, tz, showUser, onChange }: { e: Entry; tz: string; showUser?: boolean; onChange: () => void }) {
  const t = useT('pm');
  const [note, setNote] = useState(e.note);
  useEffect(() => setNote(e.note), [e.note]);
  const locked = !!e.invoice_number || e.running;
  return (
    <div className="pm-entry">
      <span className="pm-entry-when">{e.has_clock ? `${timeOf(e.started_at, tz)}–${e.ended_at ? timeOf(e.ended_at, tz) : '…'}` : t('Dauer')}</span>
      <div className="grow pm-entry-what">
        <span className="pm-entry-title">
          <ProjectDot color={e.project_color} /> {e.task_title || e.project_name || t('Ohne Aufgabe')} {e.task_title && e.project_name && <span className="muted small">· {e.project_name}</span>}
        </span>
        <input
          className="pm-plain"
          value={note}
          disabled={locked}
          placeholder={t('Notiz…')}
          aria-label={t('Notiz')}
          onChange={(ev) => setNote(ev.target.value)}
          onBlur={async () => note !== e.note && (await act(() => api.patch(`/api/pm/time/${e.id}`, { note }))) && onChange()}
        />
      </div>
      {showUser && <span className="muted small">{e.user_name}</span>}
      {e.auto_stopped && (
        <span className="badge yellow" title={t('Der Timer lief zu lange und wurde automatisch gestoppt – bitte die Zeit prüfen')}>
          {t('automatisch gestoppt')}
        </span>
      )}
      {e.invoice_number ? <Badge tone="green">{e.invoice_number}</Badge> : e.approval !== 'open' ? <Badge tone="blue">{{ submitted: 'abgegeben', approved: 'freigegeben', rejected: 'abgelehnt' }[e.approval] ?? e.approval}</Badge> : null}
      <label className="check pm-entry-bill" title={t('Abrechenbar')}>
        <input
          type="checkbox"
          checked={e.billable}
          disabled={locked}
          onChange={async (ev) => (await act(() => api.patch(`/api/pm/time/${e.id}`, { billable: ev.target.checked }))) && onChange()}
          aria-label={t('Abrechenbar')}
        />
        <Icon name="price" size={13} />
      </label>
      <strong className="pm-entry-dur">{e.running ? t('läuft') : fmtHM(e.seconds)}</strong>
      {!locked && (
        <button
          type="button"
          className="icon-btn"
          aria-label={t('Eintrag löschen')}
          onClick={async () => confirmAsk(t('Zeiteintrag löschen?')) && (await act(() => api.del(`/api/pm/time/${e.id}`))) && onChange()}
        >
          ✕
        </button>
      )}
    </div>
  );
}

function ManualEntry({ meta, projects, onClose, onSaved }: { meta: Meta; projects: Project[]; onClose: () => void; onSaved: () => void }) {
  const t = useT('pm');
  const tz = meta.timezone;
  const today = todayIn(tz);
  const [project, setProject] = useState('');
  const [task, setTask] = useState('');
  const [mode, setMode] = useState<'duration' | 'range'>('duration');
  const [day, setDay] = useState(today);
  const [dur, setDur] = useState('');
  const [from, setFrom] = useState('09:00');
  const [to, setTo] = useState('10:00');
  const [note, setNote] = useState('');
  const [bill, setBill] = useState(true);
  const [user, setUser] = useState(meta.me.id ?? '');
  const minutes = parseDuration(dur);
  const ok = (project || task) && (mode === 'duration' ? !!minutes : from < to);
  return (
    <Modal
      title={t('Zeit nachtragen')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!ok}
            onClick={async () => {
              const body: Record<string, unknown> = { project_id: project || undefined, task_id: task || undefined, note, billable: bill, user_id: meta.me.manager && user !== meta.me.id ? user : undefined };
              if (mode === 'duration') Object.assign(body, { date: day, minutes });
              else Object.assign(body, { start_at: zonedIso(day, from, tz), end_at: zonedIso(day, to, tz) });
              if (await act(() => api.post('/api/pm/time', body), t('Zeit eingetragen'))) onSaved();
            }}
          >
            {t('Eintragen')}
          </button>
        </>
      }
    >
      <div className="grid2">
        <TargetPicker projects={projects} project={project} task={task} onProject={setProject} onTask={setTask} />
      </div>
      <div className="pm-seg" role="group" aria-label={t('Eingabeart')} style={{ marginBottom: 12 }}>
        <button type="button" className={mode === 'duration' ? 'on' : ''} aria-pressed={mode === 'duration'} onClick={() => setMode('duration')}>
          {t('Dauer')}
        </button>
        <button type="button" className={mode === 'range' ? 'on' : ''} aria-pressed={mode === 'range'} onClick={() => setMode('range')}>
          {t('Von – bis')}
        </button>
      </div>
      <div className="grid3">
        <Field label={t('Datum')}>
          <input type="date" value={day} max={today} onChange={(e) => setDay(e.target.value)} />
        </Field>
        {mode === 'duration' ? (
          <Field label={t('Dauer')} hint={t('z. B. 1:30, 1,5h oder 45m')}>
            <input value={dur} onChange={(e) => setDur(e.target.value)} />
          </Field>
        ) : (
          <>
            <Field label={t('Von')}>
              <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label={t('Bis')}>
              <input type="time" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </>
        )}
      </div>
      <Field label={t('Notiz')}>
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {meta.me.manager && (
        <Field label={t('Person')}>
          <PeoplePicker single team={meta.team} value={user ? [user] : []} onChange={(ids) => setUser(ids[0] ?? meta.me.id ?? '')} empty={t('Ich')} />
        </Field>
      )}
      <label className="check">
        <input type="checkbox" checked={bill} onChange={(e) => setBill(e.target.checked)} /> {t('abrechenbar')}
      </label>
      {mode === 'range' && <p className="muted small">{t('Zeiten mit Uhrzeit dürfen sich bei einer Person nicht überschneiden (einstellbar).')}</p>}
    </Modal>
  );
}

// --- weekly timesheet ---------------------------------------------------------------------------------------------------

interface Sheet {
  week: string;
  days: string[];
  user_id: string;
  rows: { key: string; task_id: string | null; project_id: string | null; title: string; project_name: string; days: Record<string, number>; total: number }[];
  totals: Record<string, number>;
  total: number;
  billable_total: number;
  entries: Entry[];
  status: 'open' | 'submitted' | 'approved' | 'rejected';
  note: string;
  locked: boolean;
  approval_required: boolean;
}

// German labels (message ids of the pm catalog), shown through t()
const STATUS_BADGE: Record<string, [string, 'gray' | 'blue' | 'green' | 'red']> = { open: ['Offen', 'gray'], submitted: ['Abgegeben', 'blue'], approved: ['Freigegeben', 'green'], rejected: ['Abgelehnt', 'red'] };

function WeekTab({ meta }: { meta: Meta }) {
  const t = useT('pm');
  const tz = meta.timezone;
  const today = todayIn(tz);
  const [week, setWeek] = useState(mondayOf(today));
  const [user, setUser] = useState(meta.me.id ?? meta.team[0]?.id ?? '');
  const sheet = useLoad(() => api.get<Sheet>(`/api/pm/timesheet?week=${week}&user_id=${user}`), [week, user]);
  const pending = useLoad(() => api.get<{ user_id: string; user_name: string; week: string }[]>('/api/pm/timesheet/pending'), []);
  const [add, setAdd] = useState<{ row: Sheet['rows'][number]; day: string } | null>(null);
  const [note, setNote] = useState('');
  const s = sheet.data;
  const reload = () => (sheet.reload(), pending.reload(), bump());
  const own = user === meta.me.id;
  return (
    <div className="pm-weektab" data-tour="pm-timesheet">
      {meta.me.manager && (pending.data?.length ?? 0) > 0 && (
        <section className="card pm-pending" data-tour="pm-pending">
          <h2>{t('Zur Freigabe')}</h2>
          {pending.data!.map((p) => (
            <div key={`${p.user_id}${p.week}`} className="pm-set-row">
              <span className="grow">
                <strong>{p.user_name}</strong> {t('· Woche ab')} {fmtShort(p.week)}
              </span>
              <button type="button" className="btn small secondary" onClick={() => (setUser(p.user_id), setWeek(p.week))}>
                {t('Ansehen')}
              </button>
            </div>
          ))}
        </section>
      )}
      <div className="pm-cal-bar">
        <div className="actions">
          <button type="button" className="btn small secondary" aria-label={t('Vorige Woche')} onClick={() => setWeek(addDay(week, -7))}>
            ‹
          </button>
          <button type="button" className="btn small secondary" onClick={() => setWeek(mondayOf(today))}>
            {t('Diese Woche')}
          </button>
          <button type="button" className="btn small secondary" aria-label={t('Nächste Woche')} onClick={() => setWeek(addDay(week, 7))}>
            ›
          </button>
        </div>
        <h3 className="pm-cal-title">
          {fmtShort(week)} – {fmtShort(addDay(week, 6))}
        </h3>
        <span className="grow" />
        {meta.me.manager && (
          <select value={user} onChange={(e) => setUser(e.target.value)} aria-label={t('Person')}>
            {meta.team.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.id === meta.me.id ? t(' (ich)') : ''}
              </option>
            ))}
          </select>
        )}
      </div>
      {sheet.loading && !s ? (
        <Spinner />
      ) : sheet.error && !s ? (
        <p className="pm-error">{sheet.error}</p>
      ) : s ? (
        <>
          <div className="pm-sheet-scroll">
            <table className="pm-sheet">
              <thead>
                <tr>
                  <th className="pm-sheet-task">{t('Aufgabe / Projekt')}</th>
                  {s.days.map((d) => (
                    <th key={d} className={d === today ? 'today' : ''}>
                      {fmtWd(d)}
                    </th>
                  ))}
                  <th>{t('Summe')}</th>
                </tr>
              </thead>
              <tbody>
                {s.rows.map((r) => (
                  <tr key={r.key}>
                    <th scope="row" className="pm-sheet-task">
                      {r.title} {r.project_name && r.project_name !== r.title && <span className="muted small">· {r.project_name}</span>}
                    </th>
                    {s.days.map((d) => (
                      <td key={d} className={d === today ? 'today' : ''}>
                        <button type="button" className="pm-cellbtn" disabled={s.locked || !own} aria-label={t('{title}, {day}: Zeit eintragen', { title: r.title, day: fmtWd(d) })} onClick={() => setAdd({ row: r, day: d })}>
                          {r.days[d] ? fmtHM(r.days[d]) : <span className="muted">·</span>}
                        </button>
                      </td>
                    ))}
                    <td>
                      <strong>{fmtHM(r.total)}</strong>
                    </td>
                  </tr>
                ))}
                {!s.rows.length && (
                  <tr>
                    <td colSpan={9} className="muted" style={{ padding: 18, textAlign: 'center' }}>
                      {t('In dieser Woche ist noch keine Zeit eingetragen.')}
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <th className="pm-sheet-task">{t('Summe')}</th>
                  {s.days.map((d) => (
                    <td key={d}>{s.totals[d] ? fmtHM(s.totals[d]) : ''}</td>
                  ))}
                  <td>
                    <strong>{fmtHM(s.total)}</strong>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="pm-sheet-foot">
            <span>
              {fmtHours(s.total)} {t('gesamt, davon')} {fmtHours(s.billable_total)} {t('abrechenbar')}
            </span>
            <Badge tone={STATUS_BADGE[s.status][1]}>{t(STATUS_BADGE[s.status][0])}</Badge>
            {s.note && <span className="muted small">„{s.note}“</span>}
            <span className="grow" />
            {own && s.approval_required && (s.status === 'open' || s.status === 'rejected') && (
              <button
                type="button"
                className="btn"
                disabled={!s.rows.length}
                data-tour="pm-submit-week"
                onClick={async () => {
                  if (await act(() => api.post('/api/pm/timesheet/submit', { week }), t('Woche abgegeben'))) reload();
                }}
              >
                {t('Woche abgeben')}
              </button>
            )}
            {meta.me.manager && s.status === 'submitted' && (
              <>
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('Hinweis (optional)')} aria-label={t('Hinweis')} className="pm-note-input" />
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    if (await act(() => api.post('/api/pm/timesheet/decide', { user_id: user, week, decision: 'approve', note }), t('Freigegeben'))) (setNote(''), reload());
                  }}
                >
                  {t('Freigeben')}
                </button>
                <button
                  type="button"
                  className="btn danger"
                  onClick={async () => {
                    if (await act(() => api.post('/api/pm/timesheet/decide', { user_id: user, week, decision: 'reject', note }), t('Abgelehnt'))) (setNote(''), reload());
                  }}
                >
                  {t('Ablehnen')}
                </button>
              </>
            )}
            {meta.me.manager && (s.status === 'approved' || s.status === 'rejected') && (
              <button
                type="button"
                className="btn secondary"
                onClick={async () => {
                  if (await act(() => api.post('/api/pm/timesheet/decide', { user_id: user, week, decision: 'reopen', note: '' }), t('Wieder geöffnet'))) reload();
                }}
              >
                {t('Wieder öffnen')}
              </button>
            )}
          </div>
          {s.locked && <p className="muted small">{t('Diese Woche ist')} {s.status === 'approved' ? t('freigegeben') : t('abgegeben')} {t('und gesperrt')}{meta.me.manager ? t(' – die Leitung kann sie wieder öffnen') : ''}.</p>}
          {s.entries.length > 0 && (
            <section className="card">
              <h3>{t('Einträge der Woche')}</h3>
              {s.entries.map((e) => (
                <EntryRow key={e.id} e={e} tz={tz} onChange={reload} />
              ))}
            </section>
          )}
        </>
      ) : null}
      {add && (
        <Modal title={t('Zeit eintragen')} onClose={() => setAdd(null)}>
          <AddCell row={add.row} day={add.day} onDone={() => (setAdd(null), reload())} />
        </Modal>
      )}
    </div>
  );
}

function AddCell({ row, day, onDone }: { row: { title: string; task_id: string | null; project_id: string | null }; day: string; onDone: () => void }) {
  const t = useT('pm');
  const [dur, setDur] = useState('');
  const [note, setNote] = useState('');
  const minutes = parseDuration(dur);
  return (
    <>
      <p>
        <strong>{row.title}</strong> · {fmtWd(day)}
      </p>
      <Field label={t('Dauer')} hint={t('z. B. 1:30, 1,5h oder 45m')}>
        <input value={dur} onChange={(e) => setDur(e.target.value)} autoFocus />
      </Field>
      <Field label={t('Notiz')}>
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <button
        type="button"
        className="btn"
        disabled={!minutes}
        onClick={async () => {
          if (await act(() => api.post('/api/pm/time', { task_id: row.task_id ?? undefined, project_id: row.task_id ? undefined : (row.project_id ?? undefined), date: day, minutes, note }), t('Zeit eingetragen'))) onDone();
        }}
      >
        {t('Eintragen')}
      </button>
    </>
  );
}

// --- reports --------------------------------------------------------------------------------------------------------------------

interface Report {
  group: string;
  rows: { key: string; label: string; seconds: number; billable_seconds: number; entries: number; color?: string }[];
  total_seconds: number;
  billable_seconds: number;
  entries: number;
}

// German labels (message ids of the pm catalog), shown through t()
const GROUPS: [string, string][] = [
  ['project', 'Projekt'],
  ['user', 'Person'],
  ['client', 'Kunde'],
  ['task', 'Aufgabe'],
  ['day', 'Tag'],
  ['week', 'Woche'],
];

function ReportsTab({ meta }: { meta: Meta }) {
  const t = useT('pm');
  const today = todayIn(meta.timezone);
  const [f, setF] = useState({ from: `${today.slice(0, 8)}01`, to: today, group: 'project', project: '', user: '', billable: '' });
  const projects = useLoad(() => api.get<Project[]>('/api/pm/projects?status=all'), []);
  const qs = `from=${f.from}&to=${f.to}${f.project ? `&project_id=${f.project}` : ''}${f.user ? `&user_id=${f.user}` : ''}${f.billable ? `&billable=${f.billable}` : ''}`;
  const r = useLoad(() => api.get<Report>(`/api/pm/time/report?group=${f.group}&${qs}`), [qs, f.group]);
  const max = Math.max(1, ...(r.data?.rows.map((x) => x.seconds) ?? [1]));
  const loc = localStorage.getItem('pghl.location') ?? '';
  return (
    <div className="pm-reports" data-tour="pm-reports">
      <section className="card pm-report-filters">
        <Field label={t('Von')}>
          <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        </Field>
        <Field label={t('Bis')}>
          <input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        </Field>
        <Field label={t('Gruppieren nach')}>
          <select value={f.group} onChange={(e) => setF({ ...f, group: e.target.value })}>
            {GROUPS.map(([k, l]) => (
              <option key={k} value={k}>
                {t(l)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('Projekt')}>
          <select value={f.project} onChange={(e) => setF({ ...f, project: e.target.value })}>
            <option value="">{t('Alle')}</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        {meta.me.manager && (
          <Field label={t('Person')}>
            <select value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })}>
              <option value="">{t('Alle')}</option>
              {meta.team.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={t('Abrechenbar')}>
          <select value={f.billable} onChange={(e) => setF({ ...f, billable: e.target.value })}>
            <option value="">{t('Alle')}</option>
            <option value="1">{t('Ja')}</option>
            <option value="0">{t('Nein')}</option>
          </select>
        </Field>
      </section>
      {r.loading && !r.data ? (
        <Spinner />
      ) : r.error ? (
        <p className="pm-error">{r.error}</p>
      ) : r.data ? (
        <>
          <SortableGrid id="pm-time.stats" className="stats">
            <div className="stat card">
              <div className="muted">{t('Gesamt')}</div>
              <div className="stat-value">{fmtHours(r.data.total_seconds)}</div>
              <div className="muted small">{r.data.entries} {t('Einträge')}</div>
            </div>
            <div className="stat card">
              <div className="muted">{t('Abrechenbar')}</div>
              <div className="stat-value">{fmtHours(r.data.billable_seconds)}</div>
              <div className="muted small">{r.data.total_seconds ? Math.round((r.data.billable_seconds / r.data.total_seconds) * 100) : 0} %</div>
            </div>
          </SortableGrid>
          <section className="card">
            <div className="pm-bar">
              <h2 className="pm-h2">{t('Stunden nach')} {t(GROUPS.find(([k]) => k === f.group)?.[1] ?? '')}</h2>
              <span className="grow" />
              <a className="btn small secondary" href={`/api/pm/time/export.csv?${qs}&locationId=${encodeURIComponent(loc)}`} data-tour="pm-report-csv">
                <Icon name="csv" size={13} /> {t('CSV exportieren')}
              </a>
            </div>
            {r.data.rows.map((x) => (
              <div key={x.key} className="pm-rep-row">
                <span className="pm-rep-label" title={x.label}>
                  {x.color && <ProjectDot color={x.color} />} {x.label}
                </span>
                <div className="pm-rep-bar" aria-hidden="true">
                  <i style={{ width: `${(x.seconds / max) * 100}%` }}>
                    <b style={{ width: x.seconds ? `${(x.billable_seconds / x.seconds) * 100}%` : 0 }} />
                  </i>
                </div>
                <span className="pm-rep-val">{fmtHM(x.seconds)}</span>
                <span className="muted small pm-rep-bill">{fmtHM(x.billable_seconds)} {t('abrechenbar')}</span>
              </div>
            ))}
            {!r.data.rows.length && <p className="muted">{t('Keine Zeiten im Zeitraum.')}</p>}
            <p className="muted small">{t('Der dunklere Teil des Balkens ist abrechenbar.')}</p>
          </section>
        </>
      ) : null}
    </div>
  );
}

// --- billing ------------------------------------------------------------------------------------------------------------------

interface Unbilled {
  projects: { project_id: string; name: string; entries: number; seconds: number; billed_seconds: number; amount_cents: number; contact_id: string | null; no_rate: boolean }[];
  entries: number;
  seconds: number;
  amount_cents: number;
  approval_required: boolean;
}

function BillingTab({ meta }: { meta: Meta }) {
  const t = useT('pm');
  const [inclUnapproved, setIncl] = useState(false);
  const u = useLoad(() => api.get<Unbilled>(`/api/pm/billing/unbilled${inclUnapproved ? '?include_unapproved=1' : ''}`), [inclUnapproved]);
  const [bill, setBill] = useState<Unbilled['projects'][number] | null>(null);
  return (
    <div className="pm-billing" data-tour="pm-billing">
      <p className="muted">{t('Abrechenbare, abgeschlossene Zeiten, die noch auf keiner Rechnung stehen – pro Projekt. „In Rechnung stellen“ legt einen Rechnungsentwurf an, den du in den Rechnungen prüfst und versendest.')}</p>
      {u.data?.approval_required && (
        <label className="check">
          <input type="checkbox" checked={inclUnapproved} onChange={(e) => setIncl(e.target.checked)} /> {t('Auch Zeiten, die noch nicht freigegeben sind')}
        </label>
      )}
      {u.loading && !u.data ? (
        <Spinner />
      ) : u.error ? (
        <p className="pm-error">{u.error}</p>
      ) : !u.data?.projects.length ? (
        <Empty>{t('Nichts abzurechnen – alle abrechenbaren Zeiten sind bereits berechnet')}{u.data?.approval_required && !inclUnapproved ? t(' (oder noch nicht freigegeben)') : ''}.</Empty>
      ) : (
        <>
          <SortableGrid id="pm-time.stats-2" className="stats">
            <div className="stat card">
              <div className="muted">{t('Offen')}</div>
              <div className="stat-value">{money(u.data.amount_cents)}</div>
              <div className="muted small">{fmtHours(u.data.seconds)} in {u.data.entries} {t('Einträgen')}</div>
            </div>
          </SortableGrid>
          {u.data.projects.map((p) => (
            <section key={p.project_id} className="card pm-bill-row">
              <div className="grow">
                <strong>{p.name}</strong>
                <div className="muted small">
                  {t.plural(p.entries, { other: '{n} Einträge ·' })} {fmtHours(p.seconds)}
                  {p.billed_seconds !== p.seconds ? t(' (berechnet {hours})', { hours: fmtHours(p.billed_seconds) }) : ''}
                </div>
                {p.no_rate && <div className="pm-bad small">{t('Für einen Teil fehlt ein Stundensatz (Projekt, Person oder Standard festlegen).')}</div>}
              </div>
              <strong>{money(p.amount_cents)}</strong>
              {p.project_id !== '-' && (
                <button type="button" className="btn" onClick={() => setBill(p)} data-tour="pm-bill-btn">
                  {t('In Rechnung stellen')}
                </button>
              )}
            </section>
          ))}
        </>
      )}
      {bill && <BillModal project={bill} meta={meta} unapproved={inclUnapproved} onClose={() => setBill(null)} onDone={() => (setBill(null), u.reload())} />}
    </div>
  );
}

function BillModal({ project, meta, unapproved, onClose, onDone }: { project: Unbilled['projects'][number]; meta: Meta; unapproved: boolean; onClose: () => void; onDone: () => void }) {
  const t = useT('pm');
  const [f, setF] = useState({ title: '', group_by: 'task', from: '', to: '', notes: '', incl: unapproved });
  const [busy, setBusy] = useState(false);
  const preview = useLoad(() => api.get<{ entries: { id: string }[] }>(`/api/pm/billing/entries?project_id=${project.project_id}${f.from ? `&from=${f.from}` : ''}${f.to ? `&to=${f.to}` : ''}${f.incl ? '&include_unapproved=1' : ''}`), [f.from, f.to, f.incl]);
  return (
    <Modal
      title={t('{name} abrechnen', { name: project.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || !preview.data?.entries.length}
            data-tour="pm-bill-confirm"
            onClick={async () => {
              setBusy(true);
              const r = await act(() => api.post<{ invoice: { id: string; number: string }; hours: number; amount_cents: number }>('/api/pm/billing/invoice', { project_id: project.project_id, title: f.title || undefined, group_by: f.group_by, from: f.from || undefined, to: f.to || undefined, notes: f.notes || undefined, include_unapproved: f.incl }));
              setBusy(false);
              if (r) {
                toast(t('Rechnungsentwurf {number} angelegt ({amount})', { number: r.invoice.number, amount: money(r.amount_cents) }));
                onDone();
                navigate(`invoices/${r.invoice.id}`);
              }
            }}
          >
            {t('Rechnungsentwurf anlegen')}
          </button>
        </>
      }
    >
      <Field label={t('Titel der Rechnung')} hint={t('Leer lassen für „Projektname (Zeitraum)“')}>
        <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={project.name} />
      </Field>
      <div className="grid3">
        <Field label={t('Von')}>
          <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        </Field>
        <Field label={t('Bis')}>
          <input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        </Field>
        <Field label={t('Positionen je')}>
          <select value={f.group_by} onChange={(e) => setF({ ...f, group_by: e.target.value })}>
            <option value="task">{t('Aufgabe')}</option>
            <option value="user">{t('Person')}</option>
            <option value="project">{t('Projekt')}</option>
            <option value="entry">{t('Einzelner Eintrag')}</option>
          </select>
        </Field>
      </div>
      <Field label={t('Hinweis auf der Rechnung')}>
        <input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </Field>
      {meta.settings.approval_required && (
        <label className="check">
          <input type="checkbox" checked={f.incl} onChange={(e) => setF({ ...f, incl: e.target.checked })} /> {t('Auch nicht freigegebene Zeiten')}
        </label>
      )}
      <p className="muted small">
        {preview.data ? t.plural(preview.data.entries.length, { other: '{n} Einträge werden berechnet.' }) : t('Lädt…')}
        {meta.settings.round_up_minutes ? t(' Jeder Eintrag wird auf {n} Minuten aufgerundet.', { n: meta.settings.round_up_minutes }) : ''} {t('Die Rechnung bleibt ein Entwurf, bis du sie versendest. Wird sie storniert, sind die Zeiten wieder frei.')}
      </p>
    </Modal>
  );
}

// --- settings --------------------------------------------------------------------------------------------------------------------

function SettingsTab({ meta, payments }: { meta: Meta; payments: boolean }) {
  const t = useT('pm');
  const [s, setS] = useState({ capacity_hours: String(meta.settings.capacity_hours), approval_required: meta.settings.approval_required, allow_overlap: meta.settings.allow_overlap, round_up_minutes: String(meta.settings.round_up_minutes), default_rate: centsToEuros(meta.settings.default_rate_cents), max_timer_hours: String(meta.settings.max_timer_hours), tax_rate: meta.settings.tax_rate === null ? '' : String(meta.settings.tax_rate) });
  const rates = useLoad(() => (payments ? api.get<{ rates: { id: string; user_id: string | null; project_id: string | null; rate_cents: number; project_name: string }[] }>('/api/pm/billing/rates') : Promise.resolve({ rates: [] })), []);
  return (
    <div className="pm-time-settings" data-tour="pm-time-settings">
      <section className="card">
        <h2>{t('Zeiterfassung')}</h2>
        <div className="grid2">
          <Field label={t('Kapazität pro Woche (Std.)')} hint={t('Grundlage der Auslastungsansicht')}>
            <input type="number" min={1} max={80} value={s.capacity_hours} onChange={(e) => setS({ ...s, capacity_hours: e.target.value })} />
          </Field>
          <Field label={t('Timer automatisch stoppen nach (Std.)')} hint={t('Vergessene Timer laufen nicht über Nacht weiter')}>
            <input type="number" min={1} max={24} value={s.max_timer_hours} onChange={(e) => setS({ ...s, max_timer_hours: e.target.value })} />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={s.approval_required} onChange={(e) => setS({ ...s, approval_required: e.target.checked })} /> {t('Wochenzettel müssen freigegeben werden, bevor Zeiten abgerechnet werden')}
        </label>
        <label className="check">
          <input type="checkbox" checked={s.allow_overlap} onChange={(e) => setS({ ...s, allow_overlap: e.target.checked })} /> {t('Überschneidende Zeiten einer Person erlauben')}
        </label>
        {payments && (
          <>
            <h3 className="pm-h3">{t('Abrechnung')}</h3>
            <div className="grid3">
              <Field label={t('Standard-Stundensatz (€)')} hint={t('Wenn weder Projekt noch Person einen Satz haben')}>
                <input value={s.default_rate} inputMode="decimal" onChange={(e) => setS({ ...s, default_rate: e.target.value })} />
              </Field>
              <Field label={t('Aufrunden auf')} hint={t('Jeder Eintrag wird beim Abrechnen aufgerundet')}>
                <select value={s.round_up_minutes} onChange={(e) => setS({ ...s, round_up_minutes: e.target.value })}>
                  {[0, 5, 6, 10, 15, 30, 60].map((m) => (
                    <option key={m} value={m}>
                      {m ? t.plural(m, { other: '{n} Minuten' }) : t('Exakt')}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('Steuersatz auf Rechnungen (%)')} hint={t('Leer = Standard der Rechnungen')}>
                <input type="number" min={0} max={100} value={s.tax_rate} onChange={(e) => setS({ ...s, tax_rate: e.target.value })} />
              </Field>
            </div>
          </>
        )}
        <button
          type="button"
          className="btn"
          onClick={async () => {
            const rate = s.default_rate.trim() ? eurosToCents(s.default_rate) : 0;
            if (rate === null) return toast(t('Stundensatz bitte als Zahl angeben'));
            const body: Record<string, unknown> = { capacity_hours: Number(s.capacity_hours), approval_required: s.approval_required, allow_overlap: s.allow_overlap, max_timer_hours: Number(s.max_timer_hours) };
            if (payments) Object.assign(body, { default_rate_cents: rate, round_up_minutes: Number(s.round_up_minutes), tax_rate: s.tax_rate === '' ? null : Number(s.tax_rate) });
            if (await act(() => api.put('/api/pm/settings', body), t('Gespeichert'))) refreshMeta();
          }}
        >
          {t('Speichern')}
        </button>
      </section>
      {payments && (
        <section className="card">
          <h2>{t('Stundensätze je Person')}</h2>
          <p className="muted small">{t('Gilt in allen Projekten, in denen die Person keinen eigenen Satz hat. Sätze pro Projekt stellst du in den Projekteinstellungen ein.')}</p>
          {meta.team.map((p) => {
            const r = rates.data?.rates.find((x) => !x.project_id && x.user_id === p.id);
            return (
              <div key={p.id} className="pm-set-row">
                <Avatar person={p} size={22} />
                <span className="grow">{p.name}</span>
                <PersonRate value={r?.rate_cents} onSave={async (cents) => (await act(() => api.put('/api/pm/billing/rates', { user_id: p.id, rate_cents: cents }), t('Gespeichert'))) && rates.reload()} />
                <span className="muted small">{t('€ / Std.')}</span>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

function PersonRate({ value, onSave }: { value: number | undefined; onSave: (cents: number | null) => void }) {
  const t = useT('pm');
  const [v, setV] = useState(centsToEuros(value));
  useEffect(() => setV(centsToEuros(value)), [value]);
  return (
    <input
      className="pm-rate"
      value={v}
      placeholder={t('Standard')}
      inputMode="decimal"
      aria-label={t('Stundensatz in Euro')}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (v === centsToEuros(value)) return;
        const cents = v.trim() ? eurosToCents(v) : null;
        if (v.trim() && cents === null) return toast(t('Stundensatz bitte als Zahl angeben'));
        onSave(cents);
      }}
    />
  );
}
