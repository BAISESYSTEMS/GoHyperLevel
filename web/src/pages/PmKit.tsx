import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, currentLocation } from '../api';
import { Icon } from '../icons';
import { act, toast, useLoad } from '../ui';
import './pm.css';
import { addDay, dayOf, fmtFull, fmtShort, relDay, timeOf, todayIn } from './pm-format';
import { tr, useT } from '../i18n';

export * from './pm-format';

/** Shared parts of the project planning pages: types, dates, people, small controls. */

export interface Person {
  id: string;
  name: string;
  email: string;
}
export type Category = 'todo' | 'active' | 'done';
export interface Status {
  id: string;
  name: string;
  category: Category;
  color: string;
  position: number;
}
export interface Section {
  id: string;
  name: string;
  position: number;
}
export interface FieldDef {
  id: string;
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select' | 'checkbox' | 'url';
  options: string[];
  project_id: string | null;
}
export interface Checklist {
  id: string;
  title: string;
  items: { id: string; text: string; done: boolean }[];
}
export interface Task {
  id: string;
  project_id: string | null;
  section_id: string | null;
  parent_id: string | null;
  title: string;
  description: string;
  contact_id: string | null;
  contact_name: string;
  status_id: string | null;
  status: { id: string; name: string; category: Category; color: string } | null;
  done: boolean;
  completed_at: string | null;
  priority: number;
  priority_label: string;
  start_at: string | null;
  due_at: string | null;
  estimate_minutes: number | null;
  position: number;
  tags: string[];
  custom: Record<string, any>;
  checklists: Checklist[];
  recurrence: any;
  recurrence_text: string;
  internal: boolean;
  milestone: boolean;
  assignees: Person[];
  watchers: string[];
  subtasks: { total: number; done: number };
  logged_seconds: number;
  blocked_by: string[];
  blocking: string[];
  blocked: boolean;
  project: { id: string; name: string; color: string; is_default: boolean } | null;
  created_at: string;
  updated_at: string | null;
}
export interface Project {
  id: string;
  name: string;
  description: string;
  color: string;
  status: 'active' | 'paused' | 'done' | 'archived';
  contact_id: string | null;
  company_id: string | null;
  opportunity_id: string | null;
  owner_id: string | null;
  start_at: string | null;
  due_at: string | null;
  is_default: boolean;
  portal_visible: boolean;
  billable: boolean;
  hourly_rate_cents: number | null;
  skip_weekends: boolean;
  baseline_at: string | null;
  created_at: string;
  updated_at: string;
  contact_name: string;
  company_name: string;
  opportunity_name: string;
  owner_name: string;
  progress: number;
  stats: { tasks: number; done: number; open: number; overdue: number; next_due: string | null; logged_seconds: number; billable_seconds: number };
}
export interface ProjectDetail extends Project {
  statuses: Status[];
  sections: Section[];
  fields: FieldDef[];
}
export interface Meta {
  team: Person[];
  priorities: { value: number; label: string }[];
  categories: Record<Category, string>;
  dependency_types: { type: string; label: string }[];
  field_types: string[];
  me: { id: string | null; manager: boolean };
  settings: { capacity_hours: number; approval_required: boolean; allow_overlap: boolean; round_up_minutes: number; default_rate_cents: number; max_timer_hours: number; tax_rate: number | null };
  timezone: string;
  max_file_bytes: number;
  automation: { triggers: Record<string, string>; actions: Record<string, string> };
}

// --- meta (team, settings …) once per sub-account -----------------------------------------------

const metaCache = new Map<string, Promise<Meta>>();
export const refreshMeta = () => metaCache.clear();

export function usePmMeta(): Meta | undefined {
  const loc = currentLocation();
  const [meta, setMeta] = useState<Meta>();
  useEffect(() => {
    let alive = true;
    let p = metaCache.get(loc);
    if (!p) {
      p = api.get<Meta>('/api/pm/meta');
      metaCache.set(loc, p);
      p.catch(() => metaCache.delete(loc));
    }
    p.then((m) => alive && setMeta(m)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [loc]);
  return meta;
}

// --- address bar state (?view=gantt&task=…) -------------------------------------------------------

export function useQuery(): [URLSearchParams, (patch: Record<string, string | null | undefined>) => void] {
  const [, force] = useState(0);
  useEffect(() => {
    const on = () => force((n) => n + 1);
    window.addEventListener('popstate', on);
    window.addEventListener('pghl:nav', on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener('pghl:nav', on);
    };
  }, []);
  const set = (patch: Record<string, string | null | undefined>) => {
    const n = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(patch)) (v === null || v === undefined || v === '' ? n.delete(k) : n.set(k, v));
    const qs = n.toString();
    history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}`);
    window.dispatchEvent(new Event('pghl:nav'));
  };
  return [new URLSearchParams(location.search), set];
}

/** Remembers a small per-person setting (view, grouping) in this browser; works without storage. */
export function useStored<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      return (localStorage.getItem(`pghl.pm.${key}`) as T | null) ?? initial;
    } catch {
      return initial;
    }
  });
  return [
    v,
    (n: T) => {
      setV(n);
      try {
        localStorage.setItem(`pghl.pm.${key}`, n);
      } catch {
        /* private mode */
      }
    },
  ];
}

// --- priorities ---------------------------------------------------------------------------------------------

export const PRIORITY_COLORS = ['var(--muted)', '#64748b', '#2563eb', '#ea580c', '#dc2626'];
/** German labels (message ids of the pm catalog); prioLabel() shows one in the UI language. */
export const PRIORITY_LABELS = ['Keine', 'Niedrig', 'Normal', 'Hoch', 'Dringend'];
export const prioLabel = (p: number) => {
  const t = tr('pm');
  return t(PRIORITY_LABELS[p] ?? '');
};

export function PriorityFlag({ value, label }: { value: number; label?: boolean }) {
  const t = useT('pm');
  if (!value) return label ? <span className="muted small">–</span> : null;
  return (
    <span className="pm-prio" style={{ color: PRIORITY_COLORS[value] }} title={t('Priorität: {label}', { label: prioLabel(value) })}>
      <Icon name="flag" size={13} />
      {label && <span>{prioLabel(value)}</span>}
    </span>
  );
}

// --- people ---------------------------------------------------------------------------------------------------

const PALETTE = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#059669', '#0891b2', '#ca8a04', '#4f46e5', '#be123c', '#0d9488'];
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

export function Avatar({ person, size = 24 }: { person: { id: string; name: string }; size?: number }) {
  return (
    <span className="pm-avatar" title={person.name} style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: PALETTE[hash(person.id) % PALETTE.length] }}>
      {initials(person.name)}
    </span>
  );
}

export function AvatarStack({ people, max = 3, size = 22 }: { people: { id: string; name: string }[]; max?: number; size?: number }) {
  if (!people.length) return null;
  const shown = people.slice(0, max);
  return (
    <span className="pm-avatars" title={people.map((p) => p.name).join(', ')}>
      {shown.map((p) => (
        <Avatar key={p.id} person={p} size={size} />
      ))}
      {people.length > max && (
        <span className="pm-avatar more" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}>
          +{people.length - max}
        </span>
      )}
    </span>
  );
}

// --- popover -----------------------------------------------------------------------------------------------------

/** A button that opens a small panel next to it (people, dates, tags). Esc and a click outside close it. */
export function Pop({ button, children, width = 260, label, className, disabled }: { button: ReactNode; children: (close: () => void) => ReactNode; width?: number; label: string; className?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number }>();
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btn.current!.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const down = below >= 220 || below >= above;
      const maxH = Math.max(140, Math.min(420, down ? below : above));
      setPos({ top: down ? r.bottom + 4 : Math.max(8, r.top - 4 - maxH), left, maxH });
    };
    place();
    const onDown = (e: MouseEvent) => {
      if (!panel.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', place);
    };
  }, [open, width]);
  useEffect(() => {
    // Nothing to focus inside (an empty bell, say)? The panel itself takes the focus – otherwise Esc is typed into the trigger and does nothing.
    if (open && pos) (panel.current?.querySelector<HTMLElement>('input, select, button, [tabindex]') ?? panel.current)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, !!pos]);
  return (
    <>
      <button type="button" ref={btn} disabled={disabled} className={`pm-pop-btn${className ? ` ${className}` : ''}`} aria-haspopup="dialog" aria-expanded={open} aria-label={label} onClick={() => setOpen(!open)}>
        {button}
      </button>
      {open && pos && (
        <div
          ref={panel}
          className="pm-pop"
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          style={{ top: pos.top, left: pos.left, width, maxHeight: pos.maxH, outline: 'none' }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            }
          }}
        >
          {children(close)}
        </div>
      )}
    </>
  );
}

export function PeoplePicker({ team, value, onChange, label: labelProp, single, empty: emptyProp, disabled }: { team: Person[]; value: string[]; onChange: (ids: string[]) => void; label?: string; single?: boolean; empty?: string; disabled?: boolean }) {
  const t = useT('pm');
  const label = labelProp ?? t('Zuständige');
  const empty = emptyProp ?? t('Zuweisen');
  const [q, setQ] = useState('');
  const chosen = team.filter((p) => value.includes(p.id));
  return (
    <Pop
      label={label}
      disabled={disabled}
      className="pm-people-btn"
      button={
        chosen.length ? (
          <>
            <AvatarStack people={chosen} max={4} />
            <span className="pm-people-names">{chosen.length === 1 ? chosen[0].name : t.plural(chosen.length, { other: '{n} Personen' })}</span>
          </>
        ) : (
          <span className="muted">{empty}</span>
        )
      }
    >
      {(close) => (
        <div className="pm-people">
          {team.length > 6 && <input type="search" placeholder={t('Person suchen…')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Person suchen')} />}
          <div className="pm-people-list">
            {team
              .filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()))
              .map((p) => {
                const on = value.includes(p.id);
                return (
                  <label key={p.id} className={`pm-people-row${on ? ' on' : ''}`}>
                    <input
                      type={single ? 'radio' : 'checkbox'}
                      name={single ? `pm-single-${label}` : undefined}
                      checked={on}
                      onChange={() => {
                        if (single) (onChange(on ? [] : [p.id]), close());
                        else onChange(on ? value.filter((x) => x !== p.id) : [...value, p.id]);
                      }}
                    />
                    <Avatar person={p} size={22} />
                    <span>{p.name}</span>
                  </label>
                );
              })}
            {!team.length && <p className="muted small">{t('Noch niemand im Team.')}</p>}
          </div>
          {value.length > 0 && (
            <button type="button" className="btn small secondary" onClick={() => (onChange([]), close())}>
              {t('Niemand')}
            </button>
          )}
        </div>
      )}
    </Pop>
  );
}

// --- status and priority controls ----------------------------------------------------------------------------------

export function StatusSelect({ statuses, value, onChange, compact, disabled }: { statuses: Status[]; value: string | null; onChange: (id: string) => void; compact?: boolean; disabled?: boolean }) {
  const cur = statuses.find((s) => s.id === value) ?? statuses[0];
  return (
    <span className={`pm-status${compact ? ' compact' : ''}`} style={{ '--c': cur?.color ?? '#94a3b8' } as CSSProperties}>
      <i aria-hidden="true" />
      <select value={cur?.id ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label="Status">
        {statuses.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </span>
  );
}

export function StatusDot({ status }: { status: { name: string; color: string } | null }) {
  if (!status) return null;
  return (
    <span className="pm-status static" style={{ '--c': status.color } as CSSProperties}>
      <i aria-hidden="true" />
      {status.name}
    </span>
  );
}

export function ProjectDot({ color, size = 10 }: { color: string; size?: number }) {
  return <i className="pm-dot" style={{ background: color, width: size, height: size }} aria-hidden="true" />;
}

export function DueChip({ task, tz, today }: { task: Pick<Task, 'due_at' | 'start_at' | 'done' | 'milestone'>; tz: string; today: string }) {
  const t = useT('pm');
  const due = dayOf(task.due_at, tz);
  const start = dayOf(task.start_at, tz);
  if (!due && !start) return null;
  const late = !task.done && !!due && due < today;
  const soon = !task.done && !!due && due === today;
  const text = start && due && start !== due ? `${fmtShort(start)} – ${fmtShort(due)}` : due ? relDay(due, today) : t('ab {date}', { date: fmtShort(start!) });
  return (
    <span className={`pm-due${late ? ' late' : soon ? ' today' : ''}`} title={due ? (timeOf(task.due_at, tz) ? t('Fällig {date}, {time} Uhr', { date: fmtFull(due), time: timeOf(task.due_at, tz) }) : t('Fällig {date}', { date: fmtFull(due) })) : undefined}>
      <Icon name={task.milestone ? 'flag' : 'schedule'} size={12} /> {text}
    </span>
  );
}

// --- custom fields ---------------------------------------------------------------------------------------------------

export function FieldInput({ def, value, onChange }: { def: FieldDef; value: any; onChange: (v: any) => void }) {
  switch (def.type) {
    case 'checkbox':
      return <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} aria-label={def.label} />;
    case 'select':
      return (
        <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label={def.label}>
          <option value="">–</option>
          {def.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case 'number':
      return <input type="number" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} aria-label={def.label} />;
    case 'date':
      return <input type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label={def.label} />;
    default:
      return <input type={def.type === 'url' ? 'url' : 'text'} value={value ?? ''} placeholder={def.type === 'url' ? 'https://…' : ''} onChange={(e) => onChange(e.target.value || null)} aria-label={def.label} />;
  }
}

// --- link to a contact, company or deal ----------------------------------------------------------------------------------

export function LinkPicker({ type, label, value, onChange }: { type: 'contact' | 'company' | 'opportunity'; label: string; value: { id: string; name: string } | null; onChange: (v: { id: string; name: string } | null) => void }) {
  const t = useT('pm');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ id: string; name: string; sub?: string }[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => api.get(`/api/associations/search?type=${type}&q=${encodeURIComponent(q)}&limit=8`).then(setHits).catch(() => setHits([])), 180);
    return () => clearTimeout(t);
  }, [q, open, type]);
  if (value)
    return (
      <div className="pm-linkval">
        <span>{value.name}</span>
        <button type="button" className="icon-btn" onClick={() => onChange(null)} aria-label={t('{label} entfernen', { label })}>
          ✕
        </button>
      </div>
    );
  return (
    <div className="pm-linkpick">
      <input
        type="search"
        value={q}
        placeholder={t('{label} suchen…', { label })}
        aria-label={t('{label} suchen', { label })}
        onFocus={() => setOpen(true)}
        onChange={(e) => (setQ(e.target.value), setOpen(true))}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => e.key === 'Escape' && open && (e.stopPropagation(), setOpen(false))}
      />
      {open && hits.length > 0 && (
        <div className="pm-linkhits" role="listbox">
          {hits.map((h) => (
            <button type="button" role="option" aria-selected="false" key={h.id} onMouseDown={(e) => e.preventDefault()} onClick={() => (onChange({ id: h.id, name: h.name }), setQ(''), setOpen(false))}>
              {h.name} {h.sub && <span className="muted small">{h.sub}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- small helpers -------------------------------------------------------------------------------------------------------

export function QuickAdd({ placeholder: placeholderProp, onAdd, small, tour }: { placeholder?: string; onAdd: (title: string) => Promise<unknown> | unknown; small?: boolean; tour?: string }) {
  const t = useT('pm');
  const placeholder = placeholderProp ?? t('Aufgabe hinzufügen…');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const title = text.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      await onAdd(title);
      setText('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`pm-quick${small ? ' small' : ''}`} data-tour={tour}>
      <input
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
          if (e.key === 'Escape') setText('');
        }}
      />
      {text.trim() && (
        <button type="button" className="btn small" onClick={submit} disabled={busy}>
          {t('Hinzufügen')}
        </button>
      )}
    </div>
  );
}

/** Re-renders every `ms` (running timers, "today" lines). */
export function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Task changes with a message when other tasks had to move along. */
export const taskApi = {
  patch: (id: string, body: Record<string, unknown>) => act(() => api.patch<Task>(`/api/pm/tasks/${id}`, body)),
  create: (body: Record<string, unknown>) => act(() => api.post<Task>('/api/pm/tasks', body)),
  move: (id: string, body: Record<string, unknown>) => act(() => api.post<Task>(`/api/pm/tasks/${id}/move`, body)),
  remove: (id: string) => act(() => api.del(`/api/pm/tasks/${id}`)),
  dates: async (id: string, body: { start?: string | null; due?: string | null; cascade?: boolean }) => {
    const r = await act(() => api.patch<{ task: Task; shifted: Task[]; blocked: string[] }>(`/api/pm/tasks/${id}/dates`, body));
    const t = tr('pm');
    if (r?.shifted?.length) toast(t.plural(r.shifted.length, { one: '{n} abhängige Aufgabe mitverschoben', other: '{n} abhängige Aufgaben mitverschoben' }));
    if (r?.blocked?.length) toast(t.plural(r.blocked.length, { one: '{n} erledigte Aufgabe bleibt unverändert', other: '{n} erledigte Aufgaben bleiben unverändert' }));
    return r;
  },
};

/** The project's data for the views: tasks (all, flat), statuses, sections, fields. */
export function useProjectData(projectId: string) {
  const proj = useLoad(() => api.get<ProjectDetail>(`/api/pm/projects/${projectId}`), [projectId]);
  const list = useLoad(() => api.get<{ tasks: Task[]; total: number }>(`/api/pm/tasks?project_id=${projectId}&limit=2000`), [projectId]);
  const reload = () => Promise.all([proj.reload(), list.reload()]).then(() => undefined);
  return { project: proj.data, tasks: list.data?.tasks, total: list.data?.total ?? 0, loading: proj.loading || list.loading, error: proj.error || list.error, reload };
}

export interface Filters {
  q: string;
  assignee: string;
  status: string;
  priority: string;
  tag: string;
  due: string;
  done: boolean;
}
export const NO_FILTERS: Filters = { q: '', assignee: '', status: '', priority: '', tag: '', due: '', done: true };

export function applyFilters(tasks: Task[], f: Filters, tz: string, me: string | null): Task[] {
  const today = todayIn(tz);
  const q = f.q.trim().toLowerCase();
  return tasks.filter((t) => {
    if (!f.done && t.done) return false;
    if (q && !t.title.toLowerCase().includes(q) && !t.description.toLowerCase().includes(q) && !t.tags.some((x) => x.toLowerCase().includes(q))) return false;
    if (f.assignee === 'none' ? t.assignees.length : f.assignee && !t.assignees.some((a) => a.id === (f.assignee === 'me' ? me : f.assignee))) return false;
    if (f.status && t.status_id !== f.status && t.status?.category !== f.status) return false;
    if (f.priority && String(t.priority) !== f.priority) return false;
    if (f.tag && !t.tags.includes(f.tag)) return false;
    if (f.due) {
      const d = dayOf(t.due_at, tz);
      if (f.due === 'none') return !d;
      if (!d) return false;
      if (f.due === 'overdue') return !t.done && d < today;
      if (f.due === 'today') return d === today;
      if (f.due === 'week') return d >= today && d <= addDay(today, 6);
      if (f.due === 'month') return d >= today && d <= addDay(today, 30);
    }
    return true;
  });
}

export const isFiltered = (f: Filters) => !!(f.q || f.assignee || f.status || f.priority || f.tag || f.due || !f.done);

export function FilterBar({ value, onChange, team, statuses, tags, tour }: { value: Filters; onChange: (f: Filters) => void; team: Person[]; statuses: Status[]; tags: string[]; tour?: string }) {
  const t = useT('pm');
  const set = (patch: Partial<Filters>) => onChange({ ...value, ...patch });
  // On a phone only the search shows; the rest opens with "Filter".
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 860px)').matches);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const m = window.matchMedia('(max-width: 860px)');
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  const active = [value.assignee, value.status, value.priority, value.tag, value.due].filter(Boolean).length + (value.done ? 0 : 1);
  const expanded = !narrow || open;
  return (
    <div className="pm-filters" data-tour={tour}>
      <input type="search" value={value.q} onChange={(e) => set({ q: e.target.value })} placeholder={t('Suchen…')} aria-label={t('Aufgaben suchen')} className="pm-q" />
      {narrow && (
        <button type="button" className="btn small secondary" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="filter" size={13} /> {t('Filter')}{active ? ` (${active})` : ''}
        </button>
      )}
      {expanded && (
        <>
          <select value={value.assignee} onChange={(e) => set({ assignee: e.target.value })} aria-label={t('Zuständig')}>
            <option value="">{t('Alle Personen')}</option>
            <option value="me">{t('Meine')}</option>
            <option value="none">{t('Nicht zugewiesen')}</option>
            {team.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select value={value.status} onChange={(e) => set({ status: e.target.value })} aria-label="Status">
            <option value="">{t('Alle Status')}</option>
            <option value="todo">{t('Zu erledigen')}</option>
            <option value="active">{t('In Arbeit')}</option>
            <option value="done">{t('Erledigt')}</option>
            {statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select value={value.priority} onChange={(e) => set({ priority: e.target.value })} aria-label={t('Priorität')}>
            <option value="">{t('Alle Prioritäten')}</option>
            {[4, 3, 2, 1, 0].map((p) => (
              <option key={p} value={p}>
                {prioLabel(p)}
              </option>
            ))}
          </select>
          <select value={value.due} onChange={(e) => set({ due: e.target.value })} aria-label={t('Fällig')}>
            <option value="">{t('Jede Fälligkeit')}</option>
            <option value="overdue">{t('Überfällig')}</option>
            <option value="today">{t('Heute')}</option>
            <option value="week">{t('Nächste 7 Tage')}</option>
            <option value="month">{t('Nächste 30 Tage')}</option>
            <option value="none">{t('Ohne Datum')}</option>
          </select>
          {tags.length > 0 && (
            <select value={value.tag} onChange={(e) => set({ tag: e.target.value })} aria-label="Tag">
              <option value="">{t('Alle Tags')}</option>
              {tags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          )}
          <label className="check pm-check-inline">
            <input type="checkbox" checked={value.done} onChange={(e) => set({ done: e.target.checked })} /> {t('Erledigte zeigen')}
          </label>
        </>
      )}
      {isFiltered(value) && (
        <button type="button" className="btn small secondary" onClick={() => onChange(NO_FILTERS)}>
          {t('Zurücksetzen')}
        </button>
      )}
    </div>
  );
}

export const allTags = (tasks: Task[]) => [...new Set(tasks.flatMap((t) => t.tags))].sort((a, b) => a.localeCompare(b, 'de'));

/** Position of a drop between two neighbours (for the move endpoint). */
export function neighbours<T extends { id: string }>(list: T[], index: number, skipId?: string): { before_id?: string; after_id?: string } {
  const rest = skipId ? list.filter((x) => x.id !== skipId) : list;
  return { after_id: rest[index - 1]?.id, before_id: rest[index]?.id };
}
