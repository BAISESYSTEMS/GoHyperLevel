import { useEffect, useState } from 'react';
import { api, d as dateText } from '../api';
import { Icon } from '../icons';
import { Badge, Empty, Field, Input, Link, Modal, PageHead, Spinner, act, navigate, toast, useLoad } from '../ui';
import { PmBoard } from './PmBoard';
import { PmCalendar } from './PmCalendar';
import { PmGantt } from './PmGantt';
import { PmList, type ListOpts } from './PmList';
import { PmSettings } from './PmSettings';
import { TaskModal } from './PmTask';
import { PmWorkload } from './PmWorkload';
import { Later, lazyPages } from '../lazy';
import {
  AvatarStack,
  DueChip,
  LinkPicker,
  NO_FILTERS,
  PeoplePicker,
  PriorityFlag,
  ProjectDot,
  QuickAdd,
  StatusDot,
  allTags,
  dayOf,
  eurosToCents,
  fmtHM,
  fmtShort,
  todayIn,
  useProjectData,
  usePmMeta,
  useQuery,
  useStored,
  FilterBar,
  type Filters,
  type Meta,
  type Project,
  type ProjectDetail,
  type Task,
} from './PmKit';
import { useT } from '../i18n';
import { SortableGrid } from '../sortable/Sortable';

// Budget & costs of a project (job costing, docs/projects.md#job-costing-and-retainers): its own chunk, only for the payments area.
const { PmBudgetStrip } = lazyPages(() => import('./PmBudget'), 'PmBudgetStrip');

/** Project planning: projects home, one project (list, board, calendar, Gantt, workload, settings) and "Meine Aufgaben". */

export function Pm({ path }: { path: string[] }) {
  const [a, b] = path;
  if (!a) return <PmHome />;
  if (a === 'my') return <PmMy />;
  if (a === 'task' && b) return <TaskRedirect id={b} />;
  return <PmProject key={a} id={a} />;
}

/** The task window for pages that are not a project (home, "Meine Aufgaben"). */
function TaskHost({ onChanged }: { onChanged?: () => void }) {
  const [q, setQuery] = useQuery();
  const id = q.get('task');
  if (!id) return null;
  return <TaskModal key={id} id={id} onClose={() => setQuery({ task: null })} onChanged={() => onChanged?.()} openTask={(tid) => setQuery({ task: tid })} />;
}

/** /app/pm/task/<id> (links from notifications, the app and "Verknüpfungen") opens the task in its project. */
function TaskRedirect({ id }: { id: string }) {
  const t = useT('pm');
  const [err, setErr] = useState('');
  useEffect(() => {
    api
      .get<{ task: Task }>(`/api/pm/tasks/${id}`)
      .then((r) => {
        history.replaceState(null, '', `/app/pm/${r.task.project_id}?task=${id}`);
        window.dispatchEvent(new Event('pghl:nav'));
      })
      .catch((e) => setErr((e as Error).message));
  }, [id]);
  return err ? <Empty action={<Link to="pm" className="btn">{t('Zur Projektplanung')}</Link>}>{err}</Empty> : <Spinner />;
}

// --- projects home ---------------------------------------------------------------------------------------------------

// German labels (message ids of the pm catalog), shown through t()
const STATE_LABEL: Record<string, string> = { active: 'Aktiv', paused: 'Pausiert', done: 'Abgeschlossen', archived: 'Archiviert' };

function PmHome() {
  const t = useT('pm');
  const meta = usePmMeta();
  const [filter, setFilter] = useStored<string>('home-filter', 'active');
  const [q, setQ] = useState('');
  const list = useLoad(() => api.get<Project[]>(`/api/pm/projects?status=${filter}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`), [filter, q]);
  const [creating, setCreating] = useState(false);
  const tz = meta?.timezone ?? 'Europe/Berlin';
  const today = todayIn(tz);
  return (
    <>
      <PageHead title={t('Projektplanung')} sub={t('Projekte, Aufgaben, Termine und Zeiten – für dich und dein Team.')}>
        <Link to="pm/my" className="btn secondary" tour="pm-my-link">
          <Icon name="tasks" size={14} /> {t('Meine Aufgaben')}
        </Link>
        <Link to="time" className="btn secondary">
          <Icon name="schedule" size={14} /> {t('Zeiterfassung')}
        </Link>
        <button type="button" className="btn" onClick={() => setCreating(true)} data-tour="pm-new-project">
          {t('+ Neues Projekt')}
        </button>
      </PageHead>
      <div className="pm-bar">
        <div className="tabs pm-home-tabs" role="tablist">
          {[
            ['active', t('Aktiv')],
            ['paused', t('Pausiert')],
            ['done', t('Abgeschlossen')],
            ['archived', t('Archiv')],
            ['all', t('Alle')],
          ].map(([k, l]) => (
            <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
              {l}
            </button>
          ))}
        </div>
        <input type="search" className="pm-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Projekt suchen…')} aria-label={t('Projekt suchen')} />
      </div>
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.error ? (
        <p className="pm-error">{list.error}</p>
      ) : !list.data?.length ? (
        <Empty
          tour="pm-empty"
          action={
            <button type="button" className="btn" onClick={() => setCreating(true)}>
              {t('+ Neues Projekt')}
            </button>
          }
        >
          {q ? t('Kein Projekt gefunden.') : t('Hier ist noch nichts. Lege ein Projekt an – leer oder aus einer Vorlage wie „Kunden-Onboarding“.')}
        </Empty>
      ) : (
        <SortableGrid id="pm-projects" className="pm-projects" data-tour="pm-projects">
          {list.data.map((p) => (
            <article key={p.id} className="pm-project-card" style={{ '--pc': p.color } as React.CSSProperties}>
              <h2>
                <Link to={`pm/${p.id}`}>{p.name}</Link>
              </h2>
              <div className="pm-project-meta">
                {p.status !== 'active' && <Badge tone={p.status === 'done' ? 'green' : p.status === 'paused' ? 'yellow' : 'gray'}>{t(STATE_LABEL[p.status] ?? '')}</Badge>}
                {p.is_default && <Badge tone="gray">{t('Standard')}</Badge>}
                {p.portal_visible && <Badge tone="blue">{t('Im Kundenportal')}</Badge>}
                {(p.contact_name || p.company_name || p.opportunity_name) && (
                  <span className="muted small">
                    <Icon name="contact" size={12} /> {p.contact_name || p.company_name || p.opportunity_name}
                  </span>
                )}
              </div>
              {p.description && <p className="muted small pm-project-desc">{p.description}</p>}
              <div className="pm-bar-track" role="img" aria-label={t('{n} % erledigt', { n: p.progress })}>
                <i style={{ width: `${p.progress}%` }} />
              </div>
              <div className="pm-project-stats">
                <span>
                  {p.stats.done}/{p.stats.tasks} {t('erledigt')}
                </span>
                {p.stats.overdue > 0 && <span className="pm-bad">{p.stats.overdue} {t('überfällig')}</span>}
                {p.stats.next_due && <span className="muted">{t('nächste Frist')} {fmtShort(dayOf(p.stats.next_due, tz) ?? today)}</span>}
                {p.stats.logged_seconds > 0 && <span className="muted">{fmtHM(p.stats.logged_seconds)} {t('Std.')}</span>}
              </div>
            </article>
          ))}
        </SortableGrid>
      )}
      {creating && <NewProject meta={meta} onClose={() => setCreating(false)} />}
      <TaskHost />
    </>
  );
}

function NewProject({ meta, onClose }: { meta?: Meta; onClose: () => void }) {
  const t = useT('pm');
  const templates = useLoad(() => api.get<{ projects: { id: string; name: string; description: string; builtin: boolean; tasks: number }[] }>('/api/pm/templates'), []);
  const [f, setF] = useState({ name: '', template: '', start: todayIn(meta?.timezone ?? 'Europe/Berlin'), rate: '', billable: true });
  const [contact, setContact] = useState<{ id: string; name: string } | null>(null);
  const [company, setCompany] = useState<{ id: string; name: string } | null>(null);
  const [deal, setDeal] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const tpl = templates.data?.projects.find((tk) => tk.id === f.template);
  const create = async () => {
    const cents = f.rate.trim() ? eurosToCents(f.rate) : undefined;
    if (f.rate.trim() && cents === null) return toast(t('Stundensatz bitte als Zahl angeben'));
    setBusy(true);
    const r = await act(() =>
      api.post<Project>('/api/pm/projects', {
        name: f.name.trim() || tpl?.name || t('Neues Projekt'),
        template: f.template || undefined,
        start: f.template ? f.start : undefined,
        billable: f.billable,
        hourly_rate_cents: cents ?? undefined,
        contact_id: contact?.id,
        company_id: company?.id,
        opportunity_id: deal?.id,
      }),
    );
    setBusy(false);
    if (r) (onClose(), navigate(`pm/${r.id}`));
  };
  return (
    <Modal title={t('Neues Projekt')} onClose={onClose} footer={
      <>
        <button type="button" className="btn secondary" onClick={onClose}>
          {t('Abbrechen')}
        </button>
        <button type="button" className="btn" disabled={busy || (!f.name.trim() && !f.template)} onClick={create} data-tour="pm-create-project">
          {t('Projekt anlegen')}
        </button>
      </>
    }>
      <Field label="Name" tour="pm-project-name">
        <Input value={f.name} onChange={(v) => setF({ ...f, name: v })} placeholder={tpl?.name ?? t('z. B. Website-Relaunch Müller GmbH')} autoFocus />
      </Field>
      <Field label={t('Vorlage')} tour="pm-project-template" hint={tpl ? `${tpl.description || ''} ${t.plural(tpl.tasks, { other: '{n} Aufgaben, Termine relativ zum Start.' })}` : t('Eine Vorlage bringt Aufgaben, Unteraufgaben, Abhängigkeiten und Status mit.')}>
        <select value={f.template} onChange={(e) => setF({ ...f, template: e.target.value })}>
          <option value="">{t('Leeres Projekt')}</option>
          {(templates.data?.projects ?? []).map((tk) => (
            <option key={tk.id} value={tk.id}>
              {tk.name}
              {tk.builtin ? '' : t(' (eigene)')}
            </option>
          ))}
        </select>
      </Field>
      {f.template && (
        <Field label={t('Startdatum')}>
          <input type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
        </Field>
      )}
      <div className="grid3">
        <Field label={t('Kontakt (Kunde)')}>
          <LinkPicker type="contact" label={t('Kontakt')} value={contact} onChange={setContact} />
        </Field>
        <Field label={t('Firma')}>
          <LinkPicker type="company" label={t('Firma')} value={company} onChange={setCompany} />
        </Field>
        <Field label={t('Deal')}>
          <LinkPicker type="opportunity" label={t('Deal')} value={deal} onChange={setDeal} />
        </Field>
      </div>
      <div className="grid2">
        <Field label={t('Stundensatz (€, optional)')}>
          <input value={f.rate} inputMode="decimal" placeholder={t('z. B. 95')} onChange={(e) => setF({ ...f, rate: e.target.value })} />
        </Field>
        <label className="check pm-check-end">
          <input type="checkbox" checked={f.billable} onChange={(e) => setF({ ...f, billable: e.target.checked })} /> {t('Zeiten abrechenbar')}
        </label>
      </div>
    </Modal>
  );
}

// --- one project ----------------------------------------------------------------------------------------------------

// German labels (message ids of the pm catalog), shown through t()
const VIEWS: [string, string, string][] = [
  ['list', 'Liste', 'list'],
  ['board', 'Board', 'kanban'],
  ['calendar', 'Kalender', 'calendars'],
  ['gantt', 'Gantt', 'gantt'],
  ['workload', 'Auslastung', 'gauge'],
  ['settings', 'Einstellungen', 'settings'],
];

interface SavedView {
  id: string;
  name: string;
  kind: string;
  shared: boolean;
  user_id: string | null;
  config: { filters?: Filters; list?: ListOpts };
}

function PmProject({ id }: { id: string }) {
  const t = useT('pm');
  const meta = usePmMeta();
  const data = useProjectData(id);
  const [q, setQuery] = useQuery();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [opts, setOpts] = useStored<string>('list-opts', JSON.stringify({ group: 'section', sort: 'manual', dir: 'asc' }));
  const [tick, setTick] = useState(0);
  const [newTask, setNewTask] = useState(false);
  const [saving, setSaving] = useState(false);
  const views = useLoad(() => api.get<SavedView[]>(`/api/pm/views?project_id=${id}`), [id]);
  const [activeView, setActiveView] = useState('');
  const view = VIEWS.some((v) => v[0] === q.get('view')) ? q.get('view')! : 'list';
  const taskId = q.get('task');
  const listOpts: ListOpts = (() => {
    try {
      return JSON.parse(opts);
    } catch {
      return { group: 'section', sort: 'manual', dir: 'asc' };
    }
  })();
  const reload = async () => {
    await data.reload();
    setTick((n) => n + 1);
  };

  if (data.error && !data.project) return <Empty action={<Link to="pm" className="btn">{t('Zu den Projekten')}</Link>}>{data.error}</Empty>;
  if (!data.project || !data.tasks || !meta) return <Spinner />;
  const p: ProjectDetail = data.project;
  const tasks = data.tasks;
  const tz = meta.timezone;
  const contactLink = p.contact_id ? `contacts/${p.contact_id}` : p.company_id ? `companies/${p.company_id}` : p.opportunity_id ? 'opportunities' : '';
  const customer = p.contact_name || p.company_name || p.opportunity_name;
  const showFilters = view === 'list' || view === 'board' || view === 'calendar';

  const applyView = (v: SavedView) => {
    setActiveView(v.id);
    setQuery({ view: v.kind });
    setFilters({ ...NO_FILTERS, ...(v.config.filters ?? {}) });
    if (v.config.list) setOpts(JSON.stringify(v.config.list));
  };

  return (
    <>
      <div className="pm-crumb">
        <Link to="pm">{t('← Projekte')}</Link>
      </div>
      <div className="pm-project-head">
        <div className="pm-project-title">
          <ProjectDot color={p.color} size={14} />
          <h1>{p.name}</h1>
          {p.status !== 'active' && <Badge tone={p.status === 'done' ? 'green' : p.status === 'paused' ? 'yellow' : 'gray'}>{t(STATE_LABEL[p.status] ?? '')}</Badge>}
          {p.portal_visible && <Badge tone="blue">{t('Im Kundenportal')}</Badge>}
        </div>
        <div className="pm-project-sub muted">
          {customer && (
            <Link to={contactLink}>
              <Icon name="contact" size={13} /> {customer}
            </Link>
          )}
          {p.owner_name && <span>{t('Verantwortlich:')} {p.owner_name}</span>}
          {(p.start_at || p.due_at) && (
            <span>
              {p.start_at ? fmtShort(dayOf(p.start_at, tz)!) : '…'} – {p.due_at ? dateText(p.due_at) : '…'}
            </span>
          )}
        </div>
        <div className="pm-project-progress">
          <div className="pm-bar-track" role="img" aria-label={t('{n} % erledigt', { n: p.progress })}>
            <i style={{ width: `${p.progress}%` }} />
          </div>
          <span className="small">
            {p.stats.done}/{p.stats.tasks} {t('erledigt')}{p.stats.overdue > 0 && <span className="pm-bad"> · {p.stats.overdue} {t('überfällig')}</span>}
            {p.stats.logged_seconds > 0 && <span className="muted"> · {fmtHM(p.stats.logged_seconds)} {t('Std. erfasst')}</span>}
          </span>
        </div>
        <Later>
          <PmBudgetStrip projectId={p.id} />
        </Later>
        <div className="actions pm-project-actions">
          <button type="button" className="btn" onClick={() => setNewTask(true)} data-tour="pm-new-task">
            {t('+ Aufgabe')}
          </button>
        </div>
      </div>

      <div className="pm-viewbar">
        <div className="tabs pm-viewtabs" role="tablist" data-tour="pm-views">
          {VIEWS.map(([k, l, ic]) => (
            <button key={k} role="tab" aria-selected={view === k} className={view === k ? 'on' : ''} onClick={() => (setActiveView(''), setQuery({ view: k === 'list' ? null : k }))} data-tour={`pm-view-${k}`}>
              <Icon name={ic as any} size={14} /> {t(l)}
            </button>
          ))}
        </div>
        {showFilters && (
          <div className="pm-savedviews" data-tour="pm-saved-views">
            {(views.data?.length ?? 0) > 0 && (
              <select
                value={activeView}
                aria-label={t('Gespeicherte Ansicht')}
                onChange={(e) => {
                  const v = views.data?.find((x) => x.id === e.target.value);
                  if (v) applyView(v);
                  else setActiveView('');
                }}
              >
                <option value="">{t('Ansichten …')}</option>
                {views.data!.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {v.shared ? t(' (Team)') : ''}
                  </option>
                ))}
              </select>
            )}
            <button type="button" className="btn small secondary" onClick={() => setSaving(true)}>
              {t('Ansicht speichern')}
            </button>
            {activeView && (
              <button
                type="button"
                className="icon-btn"
                aria-label={t('Gespeicherte Ansicht löschen')}
                onClick={async () => {
                  if (await act(() => api.del(`/api/pm/views/${activeView}`), t('Ansicht gelöscht'))) (setActiveView(''), await views.reload());
                }}
              >
                ✕
              </button>
            )}
          </div>
        )}
      </div>

      {showFilters && <FilterBar tour="pm-filters" value={filters} onChange={(f) => (setActiveView(''), setFilters(f))} team={meta.team} statuses={p.statuses} tags={allTags(tasks)} />}

      {view === 'list' && <PmList project={p} tasks={tasks} filters={filters} meta={meta} opts={listOpts} onOpts={(o) => setOpts(JSON.stringify(o))} reload={reload} openTask={(tid) => setQuery({ task: tid })} />}
      {view === 'board' && <PmBoard project={p} tasks={tasks} filters={filters} meta={meta} reload={reload} openTask={(tid) => setQuery({ task: tid })} />}
      {view === 'calendar' && <PmCalendar project={p} tasks={tasks} filters={filters} meta={meta} reload={reload} openTask={(tid) => setQuery({ task: tid })} />}
      {view === 'gantt' && <PmGantt project={p} meta={meta} version={tick} reload={reload} openTask={(tid) => setQuery({ task: tid })} />}
      {view === 'workload' && <PmWorkload project={p} meta={meta} version={tick} />}
      {view === 'settings' && <PmSettings project={p} reload={reload} />}

      {taskId && <TaskModal key={taskId} id={taskId} onClose={() => setQuery({ task: null })} onChanged={() => void reload()} openTask={(tid) => setQuery({ task: tid })} />}
      {newTask && <NewTask project={p} meta={meta} onClose={() => setNewTask(false)} onCreated={(tk) => (setNewTask(false), void reload(), setQuery({ task: tk.id }))} />}
      {saving && (
        <SaveView
          manager={meta.me.manager}
          onClose={() => setSaving(false)}
          onSave={async (name, shared) => {
            const r = await act(() => api.post<SavedView>('/api/pm/views', { name, shared, kind: view, project_id: id, config: { filters, list: listOpts } }), t('Ansicht gespeichert'));
            if (r) (setSaving(false), await views.reload(), setActiveView(r.id));
          }}
        />
      )}
    </>
  );
}

function SaveView({ manager, onClose, onSave }: { manager: boolean; onClose: () => void; onSave: (name: string, shared: boolean) => void }) {
  const t = useT('pm');
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  return (
    <Modal title={t('Ansicht speichern')} onClose={onClose}>
      <p className="muted small">{t('Merkt sich die Darstellung (Liste, Board …), alle Filter, Gruppierung und Sortierung.')}</p>
      <Field label="Name">
        <Input value={name} onChange={setName} placeholder={t('z. B. Meine offenen Aufgaben')} autoFocus />
      </Field>
      {manager && (
        <label className="check">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> {t('Für das ganze Team freigeben')}
        </label>
      )}
      <div className="actions" style={{ marginTop: 12 }}>
        <button type="button" className="btn" disabled={!name.trim()} onClick={() => onSave(name.trim(), shared)}>
          {t('Speichern')}
        </button>
        <button type="button" className="btn secondary" onClick={onClose}>
          {t('Abbrechen')}
        </button>
      </div>
    </Modal>
  );
}

function NewTask({ project, meta, onClose, onCreated }: { project: ProjectDetail; meta: Meta; onClose: () => void; onCreated: (tk: Task) => void }) {
  const t = useT('pm');
  const [f, setF] = useState({ title: '', due: '', status: project.statuses[0]?.id ?? '', section: '', assignees: [] as string[] });
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={t('Neue Aufgabe')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!f.title.trim() || busy}
            onClick={async () => {
              setBusy(true);
              const r = await act(() => api.post<Task>('/api/pm/tasks', { title: f.title.trim(), project_id: project.id, due_at: f.due || undefined, status_id: f.status || undefined, section_id: f.section || undefined, assignees: f.assignees }));
              setBusy(false);
              if (r) onCreated(r);
            }}
          >
            {t('Anlegen')}
          </button>
        </>
      }
    >
      <Field label={t('Titel')}>
        <Input value={f.title} onChange={(v) => setF({ ...f, title: v })} autoFocus placeholder={t('Was ist zu tun?')} />
      </Field>
      <div className="grid2">
        <Field label={t('Fällig')}>
          <input type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} />
        </Field>
        <Field label={t('Zuständig')}>
          <PeoplePicker team={meta.team} value={f.assignees} onChange={(ids) => setF({ ...f, assignees: ids })} />
        </Field>
        <Field label="Status">
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            {project.statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('Abschnitt')}>
          <select value={f.section} onChange={(e) => setF({ ...f, section: e.target.value })}>
            <option value="">{t('Kein Abschnitt')}</option>
            {project.sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

// --- "Meine Aufgaben" --------------------------------------------------------------------------------------------------

interface My {
  today: string;
  buckets: Record<'overdue' | 'today' | 'week' | 'later' | 'nodate', Task[]>;
  counts: Record<string, number>;
  total: number;
  watching: Task[];
}

// German labels (message ids of the pm catalog), shown through t()
const BUCKETS: ['overdue' | 'today' | 'week' | 'later' | 'nodate', string][] = [
  ['overdue', 'Überfällig'],
  ['today', 'Heute'],
  ['week', 'Diese Woche'],
  ['later', 'Später'],
  ['nodate', 'Ohne Datum'],
];

function PmMy() {
  const t = useT('pm');
  const meta = usePmMeta();
  const my = useLoad(() => api.get<My>('/api/pm/my-tasks?watching=1'), []);
  const projects = useLoad(() => api.get<Project[]>('/api/pm/projects'), []);
  const timer = useLoad(() => api.get<{ running: { task_id: string | null } | null }>('/api/pm/timer'), []);
  const [project, setProject] = useState('');
  const [, setQuery] = useQuery();
  const tz = meta?.timezone ?? 'Europe/Berlin';
  const today = todayIn(tz);
  const reload = () => (my.reload(), timer.reload());
  const home = projects.data?.find((p) => p.is_default);
  const row = (tk: Task) => (
    <div key={tk.id} className={`pm-myrow${tk.done ? ' done' : ''}`}>
      <input
        type="checkbox"
        className="pm-round"
        checked={tk.done}
        aria-label={t('{title} erledigen', { title: tk.title })}
        onChange={async (e) => {
          if (await act(() => api.patch(`/api/pm/tasks/${tk.id}`, { done: e.target.checked }))) reload();
        }}
      />
      <button type="button" className="pm-title-btn grow" onClick={() => setQuery({ task: tk.id })}>
        {tk.parent_id && <span className="muted">↳ </span>}
        {tk.title}
      </button>
      {tk.project && (
        <Link to={`pm/${tk.project.id}`} className="pm-projchip">
          <ProjectDot color={tk.project.color} /> {tk.project.name}
        </Link>
      )}
      <StatusDot status={tk.status} />
      <PriorityFlag value={tk.priority} />
      <AvatarStack people={tk.assignees} max={2} size={20} />
      <DueChip task={tk} tz={tz} today={today} />
      <button
        type="button"
        className="icon-btn"
        title={timer.data?.running?.task_id === tk.id ? t('Timer stoppen') : t('Timer starten')}
        aria-label={timer.data?.running?.task_id === tk.id ? t('Timer für {title} stoppen', { title: tk.title }) : t('Timer für {title} starten', { title: tk.title })}
        onClick={async () => {
          const running = timer.data?.running?.task_id === tk.id;
          if (await act(() => (running ? api.post('/api/pm/timer/stop', {}) : api.post('/api/pm/timer/start', { task_id: tk.id })))) (window.dispatchEvent(new Event('pm:timer')), reload());
        }}
      >
        <Icon name={timer.data?.running?.task_id === tk.id ? 'end' : 'play'} size={14} />
      </button>
    </div>
  );
  return (
    <>
      <div className="pm-crumb">
        <Link to="pm">{t('← Projekte')}</Link>
      </div>
      <PageHead title={t('Meine Aufgaben')} sub={t('Alles, was dir zugewiesen ist – über alle Projekte hinweg.')}>
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label={t('Projekt filtern')}>
          <option value="">{t('Alle Projekte')}</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </PageHead>
      {home && meta?.me.id && (
        <QuickAdd
          tour="pm-my-add"
          placeholder={t('Neue Aufgabe für mich…')}
          onAdd={async (title) => {
            if (await act(() => api.post('/api/pm/tasks', { title, project_id: project || home.id, assignees: [meta.me.id] }))) reload();
          }}
        />
      )}
      {my.loading && !my.data ? (
        <Spinner />
      ) : my.error ? (
        <p className="pm-error">{my.error}</p>
      ) : (
        <div className="pm-my" data-tour="pm-my">
          {BUCKETS.map(([k, label]) => {
            const list = (my.data?.buckets[k] ?? []).filter((tk) => !project || tk.project_id === project);
            if (!list.length) return null;
            return (
              <section key={k} className="card pm-my-sec">
                <h2 className={k === 'overdue' ? 'pm-bad' : ''}>
                  {t(label)} <span className="muted small">{list.length}</span>
                </h2>
                {list.map(row)}
              </section>
            );
          })}
          {(my.data?.watching ?? []).filter((tk) => !project || tk.project_id === project).length > 0 && (
            <section className="card pm-my-sec">
              <h2>
                {t('Beobachtet')} <span className="muted small">{my.data!.watching.length}</span>
              </h2>
              {my.data!.watching.filter((tk) => !project || tk.project_id === project).map(row)}
            </section>
          )}
          {!my.data?.total && !my.data?.watching.length && <Empty>{t('Nichts zu tun – dir ist gerade nichts zugewiesen.')}</Empty>}
        </div>
      )}
      <TaskHost onChanged={reload} />
    </>
  );
}
