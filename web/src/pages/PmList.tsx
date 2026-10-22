import { useMemo, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { TagInput, act, confirmAsk, toast } from '../ui';
import {
  AvatarStack,
  DueChip,
  PRIORITY_COLORS,
  prioLabel,
  PeoplePicker,
  QuickAdd,
  StatusDot,
  StatusSelect,
  addDay,
  applyFilters,
  dayOf,
  fmtMinutes,
  isFiltered,
  taskApi,
  todayIn,
  type Filters,
  type Meta,
  type ProjectDetail,
  type Task,
} from './PmKit';
import { useT } from '../i18n';

/** List view: grouping, sorting, filters (from the bar above), subtasks, inline edits and bulk editing. */

type Group = 'section' | 'status' | 'assignee' | 'priority' | 'due' | 'none';
type Sort = 'manual' | 'due' | 'priority' | 'title' | 'created' | 'updated';
export interface ListOpts {
  group: Group;
  sort: Sort;
  dir: 'asc' | 'desc';
}

interface Bucket {
  key: string;
  label: string;
  color?: string;
  roots: Task[];
  /** What a task dropped on this group gets. */
  patch?: Record<string, unknown>;
  /** What a task added here starts with. */
  defaults: Record<string, unknown>;
}

export function PmList({ project, tasks, filters, meta, opts, onOpts, reload, openTask, onSelectionChange }: { project: ProjectDetail; tasks: Task[]; filters: Filters; meta: Meta; opts: ListOpts; onOpts: (o: ListOpts) => void; reload: () => Promise<unknown>; openTask: (id: string) => void; onSelectionChange?: (n: number) => void }) {
  const t = useT('pm');
  const tz = meta.timezone;
  const today = todayIn(tz);
  const { group, sort, dir } = opts;
  const setGroup = (v: Group) => onOpts({ ...opts, group: v });
  const setSort = (v: Sort) => onOpts({ ...opts, sort: v });
  const setDir = (v: 'asc' | 'desc') => onOpts({ ...opts, dir: v });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const filtered = isFiltered(filters);

  const select = (next: Set<string>) => {
    setSelected(next);
    onSelectionChange?.(next.size);
  };
  const toggleCollapsed = (key: string) => setCollapsed((c) => (c.has(key) ? new Set([...c].filter((x) => x !== key)) : new Set([...c, key])));

  const model = useMemo(() => {
    const rows = applyFilters(tasks, filters, tz, meta.me.id);
    const ids = new Set(rows.map((tk) => tk.id));
    const kids = new Map<string, Task[]>();
    const roots: Task[] = [];
    for (const tk of rows) {
      if (tk.parent_id && ids.has(tk.parent_id)) kids.set(tk.parent_id, [...(kids.get(tk.parent_id) ?? []), tk]);
      else roots.push(tk);
    }
    const manual = (a: Task, b: Task) => a.position - b.position || a.created_at.localeCompare(b.created_at);
    const dueKey = (tk: Task) => dayOf(tk.due_at, tz) ?? '9999';
    const base: Record<Sort, (a: Task, b: Task) => number> = {
      manual,
      due: (a, b) => dueKey(a).localeCompare(dueKey(b)) || manual(a, b),
      priority: (a, b) => b.priority - a.priority || dueKey(a).localeCompare(dueKey(b)) || manual(a, b),
      title: (a, b) => a.title.localeCompare(b.title, 'de'),
      created: (a, b) => a.created_at.localeCompare(b.created_at),
      updated: (a, b) => (a.updated_at ?? a.created_at).localeCompare(b.updated_at ?? b.created_at),
    };
    const compare = (a: Task, b: Task) => (dir === 'desc' ? -1 : 1) * base[sort](a, b);
    const buckets: Bucket[] = [];
    const put = (key: string, label: string, tk: Task, extra: Partial<Bucket> = {}) => {
      let b = buckets.find((x) => x.key === key);
      if (!b) {
        b = { key, label, roots: [], defaults: {}, ...extra };
        buckets.push(b);
      }
      b.roots.push(tk);
    };
    const bucketOf = (tk: Task) => {
      switch (group) {
        case 'section': {
          const s = project.sections.find((x) => x.id === tk.section_id);
          return s ? put(s.id, s.name, tk, { patch: { section_id: s.id }, defaults: { section_id: s.id } }) : put('none', t('Ohne Abschnitt'), tk, { patch: { section_id: null }, defaults: {} });
        }
        case 'status': {
          const s = project.statuses.find((x) => x.id === tk.status_id) ?? project.statuses[0];
          return put(s.id, s.name, tk, { color: s.color, patch: { status_id: s.id }, defaults: { status_id: s.id } });
        }
        case 'assignee': {
          const a = tk.assignees[0];
          return a ? put(a.id, a.name, tk, { patch: { assignees: [a.id] }, defaults: { assignees: [a.id] } }) : put('none', t('Nicht zugewiesen'), tk, { patch: { assignees: [] }, defaults: {} });
        }
        case 'priority':
          return put(String(tk.priority), prioLabel(tk.priority), tk, { color: PRIORITY_COLORS[tk.priority], patch: { priority: tk.priority }, defaults: { priority: tk.priority } });
        case 'due': {
          const d = dayOf(tk.due_at, tz);
          const k = !d ? 'none' : tk.done ? 'later' : d < today ? 'overdue' : d === today ? 'today' : d <= addDay(today, 6) ? 'week' : 'later';
          return put(k, { overdue: t('Überfällig'), today: t('Heute'), week: t('Diese Woche'), later: t('Später'), none: t('Ohne Datum') }[k]!, tk, { color: k === 'overdue' ? 'var(--red)' : undefined });
        }
        default:
          return put('all', '', tk);
      }
    };
    for (const tk of roots) bucketOf(tk);
    // Fixed order of the groups; empty sections/statuses stay (to add tasks) unless a filter is active.
    const order: string[] =
      group === 'section'
        ? [...project.sections.map((s) => s.id), 'none']
        : group === 'status'
          ? project.statuses.map((s) => s.id)
          : group === 'assignee'
            ? [...meta.team.map((p) => p.id), 'none']
            : group === 'priority'
              ? ['4', '3', '2', '1', '0']
              : group === 'due'
                ? ['overdue', 'today', 'week', 'later', 'none']
                : ['all'];
    if (!filtered && group === 'section') for (const s of project.sections) if (!buckets.some((b) => b.key === s.id)) buckets.push({ key: s.id, label: s.name, roots: [], patch: { section_id: s.id }, defaults: { section_id: s.id } });
    if (!filtered && group === 'status') for (const s of project.statuses) if (!buckets.some((b) => b.key === s.id)) buckets.push({ key: s.id, label: s.name, color: s.color, roots: [], patch: { status_id: s.id }, defaults: { status_id: s.id } });
    if (group === 'section' && !buckets.some((b) => b.key === 'none') && !project.sections.length) buckets.push({ key: 'none', label: '', roots: [], defaults: {} });
    buckets.sort((a, b) => (order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99));
    for (const b of buckets) b.roots.sort(compare);
    for (const list of kids.values()) list.sort(compare);
    return { buckets, kids, count: rows.length };
  }, [tasks, filters, tz, group, sort, dir, project.sections, project.statuses, meta.team, meta.me.id, today, filtered]);

  const people = meta.team;
  const rowsOf = (b: Bucket) => {
    const out: { task: Task; depth: number }[] = [];
    const walk = (tk: Task, depth: number) => {
      out.push({ task: tk, depth });
      if (!collapsed.has(tk.id)) for (const k of model.kids.get(tk.id) ?? []) walk(k, depth + 1);
    };
    for (const tk of b.roots) walk(tk, 0);
    return out;
  };

  const afterWrite = async (r: unknown) => {
    if (r) await reload();
    return r;
  };
  const sortHead = (key: Sort, label: string) => (
    <button
      type="button"
      className={`pm-th${sort === key ? ' on' : ''}`}
      aria-label={t('Nach {label} sortieren', { label })}
      onClick={() => (sort === key ? setDir(dir === 'asc' ? 'desc' : 'asc') : onOpts({ ...opts, sort: key, dir: 'asc' }))}
    >
      {label} {sort === key && <span aria-hidden="true">{dir === 'asc' ? '↑' : '↓'}</span>}
    </button>
  );
  const allIds = model.buckets.flatMap((b) => rowsOf(b).map((r) => r.task.id));

  const bulk = async (body: Record<string, unknown>, ok?: string) => {
    const r = await act(() => api.post<{ updated: number; failed: { id: string; error: string }[] }>('/api/pm/tasks/bulk', { ids: [...selected], ...body }));
    if (!r) return;
    if (r.failed.length) toast(t('{updated} geändert, {failed} nicht: {error}', { updated: r.updated, failed: r.failed.length, error: r.failed[0].error }));
    else if (ok) toast(ok);
    select(new Set());
    await reload();
  };

  return (
    <div className="pm-listview" data-tour="pm-list">
      <div className="pm-list-opts">
        <label>
          <span className="muted small">{t('Gruppieren')}</span>
          <select value={group} onChange={(e) => setGroup(e.target.value as Group)} aria-label={t('Gruppieren nach')}>
            <option value="section">{t('Abschnitt')}</option>
            <option value="status">Status</option>
            <option value="assignee">{t('Zuständige')}</option>
            <option value="priority">{t('Priorität')}</option>
            <option value="due">{t('Fälligkeit')}</option>
            <option value="none">{t('Keine')}</option>
          </select>
        </label>
        <label>
          <span className="muted small">{t('Sortieren')}</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={t('Sortieren nach')}>
            <option value="manual">{t('Manuell')}</option>
            <option value="due">{t('Fälligkeit')}</option>
            <option value="priority">{t('Priorität')}</option>
            <option value="title">{t('Titel')}</option>
            <option value="created">{t('Angelegt')}</option>
            <option value="updated">{t('Geändert')}</option>
          </select>
        </label>
        <button type="button" className="btn small secondary" aria-label={dir === 'asc' ? t('Aufsteigend') : t('Absteigend')} onClick={() => setDir(dir === 'asc' ? 'desc' : 'asc')}>
          {dir === 'asc' ? '↑' : '↓'}
        </button>
        <span className="grow" />
        <span className="muted small">
          {model.count} {model.count === 1 ? t('Aufgabe') : t('Aufgaben')}
        </span>
        <button type="button" className="btn small secondary" onClick={() => select(selected.size === allIds.length ? new Set() : new Set(allIds))}>
          {selected.size === allIds.length && allIds.length > 0 ? t('Auswahl aufheben') : t('Alle auswählen')}
        </button>
      </div>

      <div className="pm-table" role="table" aria-label={t('Aufgabenliste')}>
        <div className="pm-row pm-head" role="row">
          <span />
          <span />
          <span role="columnheader">{sortHead('title', t('Aufgabe'))}</span>
          <span role="columnheader" className="pm-col-assignee">{t('Zuständig')}</span>
          <span role="columnheader" className="pm-col-status">Status</span>
          <span role="columnheader" className="pm-col-prio">{sortHead('priority', t('Priorität'))}</span>
          <span role="columnheader" className="pm-col-due">{sortHead('due', t('Fällig'))}</span>
          <span role="columnheader" className="pm-col-est">{t('Aufwand')}</span>
        </div>
        {model.buckets.map((b) => {
          const rows = rowsOf(b);
          const isCollapsed = collapsed.has(`g:${b.key}`);
          return (
            <div
              key={b.key}
              className={`pm-group${over === b.key ? ' over' : ''}`}
              onDragOver={(e) => {
                if (dragging && b.patch) (e.preventDefault(), setOver(b.key));
              }}
              onDragLeave={() => over === b.key && setOver(null)}
              onDrop={async (e) => {
                e.preventDefault();
                setOver(null);
                const id = dragging;
                setDragging(null);
                if (id && b.patch) await afterWrite(await taskApi.patch(id, b.patch));
              }}
            >
              {b.label && (
                <div className="pm-group-head" data-tour="pm-group">
                  <button type="button" className="pm-caret" aria-expanded={!isCollapsed} aria-label={`${b.label} ${isCollapsed ? t('aufklappen') : t('zuklappen')}`} onClick={() => toggleCollapsed(`g:${b.key}`)}>
                    {isCollapsed ? '▸' : '▾'}
                  </button>
                  {b.color && <i className="pm-dot" style={{ background: b.color }} aria-hidden="true" />}
                  <strong>{b.label}</strong>
                  <span className="muted small">{rows.length}</span>
                </div>
              )}
              {!isCollapsed && (
                <>
                  {rows.map(({ task: tk, depth }) => (
                    <div
                      key={tk.id}
                      role="row"
                      className={`pm-row${tk.done ? ' done' : ''}${selected.has(tk.id) ? ' sel' : ''}${dragging === tk.id ? ' drag' : ''}`}
                      draggable
                      onDragStart={(e) => {
                        setDragging(tk.id);
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', tk.id);
                      }}
                      onDragEnd={() => (setDragging(null), setOver(null))}
                    >
                      <span className="pm-cell-sel">
                        <input type="checkbox" checked={selected.has(tk.id)} aria-label={t('{title} auswählen', { title: tk.title })} onChange={(e) => select(new Set(e.target.checked ? [...selected, tk.id] : [...selected].filter((x) => x !== tk.id)))} />
                      </span>
                      <span className="pm-cell-done">
                        <input type="checkbox" className="pm-round" checked={tk.done} aria-label={tk.done ? t('{title} wieder öffnen', { title: tk.title }) : t('{title} erledigen', { title: tk.title })} onChange={async (e) => afterWrite(await taskApi.patch(tk.id, { done: e.target.checked }))} />
                      </span>
                      <div className="pm-cell-title" style={{ paddingLeft: depth * 22 }}>
                        {(model.kids.get(tk.id)?.length ?? 0) > 0 ? (
                          <button type="button" className="pm-caret" aria-expanded={!collapsed.has(tk.id)} aria-label={collapsed.has(tk.id) ? t('Unteraufgaben aufklappen') : t('Unteraufgaben zuklappen')} onClick={() => toggleCollapsed(tk.id)}>
                            {collapsed.has(tk.id) ? '▸' : '▾'}
                          </button>
                        ) : (
                          <span className="pm-caret-space" />
                        )}
                        <button type="button" className="pm-title-btn" onClick={() => openTask(tk.id)}>
                          {tk.milestone && <Icon name="flag" size={13} />} {tk.title}
                        </button>
                        <span className="pm-chips">
                          {tk.subtasks.total > 0 && (
                            <span className="pm-mini" title={t('Unteraufgaben')}>
                              <Icon name="layers" size={11} /> {tk.subtasks.done}/{tk.subtasks.total}
                            </span>
                          )}
                          {tk.checklists.length > 0 && (
                            <span className="pm-mini" title={t('Checkliste')}>
                              <Icon name="features" size={11} /> {tk.checklists.reduce((s, c) => s + c.items.filter((i) => i.done).length, 0)}/{tk.checklists.reduce((s, c) => s + c.items.length, 0)}
                            </span>
                          )}
                          {tk.blocked && (
                            <span className="pm-mini warn" title={t('Wartet auf eine andere Aufgabe')}>
                              <Icon name="lock" size={11} />
                            </span>
                          )}
                          {tk.recurrence && (
                            <span className="pm-mini" title={tk.recurrence_text}>
                              <Icon name="repeat" size={11} />
                            </span>
                          )}
                          {tk.tags.slice(0, 3).map((tag) => (
                            <span key={tag} className="pm-tag">
                              {tag}
                            </span>
                          ))}
                        </span>
                        <span className="pm-row-meta">
                          <StatusDot status={tk.status} />
                          <AvatarStack people={tk.assignees} max={2} size={18} />
                          <DueChip task={tk} tz={tz} today={today} />
                        </span>
                      </div>
                      <span className="pm-col-assignee">
                        <PeoplePicker team={people} value={tk.assignees.map((a) => a.id)} onChange={async (ids) => afterWrite(await taskApi.patch(tk.id, { assignees: ids }))} label={t('Zuständige für {title}', { title: tk.title })} empty="–" />
                      </span>
                      <span className="pm-col-status">
                        <StatusSelect compact statuses={project.statuses} value={tk.status_id} onChange={async (sid) => afterWrite(await taskApi.patch(tk.id, { status_id: sid }))} />
                      </span>
                      <span className="pm-col-prio">
                        <select
                          className="pm-prio-sel"
                          value={tk.priority}
                          style={{ color: PRIORITY_COLORS[tk.priority] }}
                          aria-label={t('Priorität von {title}', { title: tk.title })}
                          onChange={async (e) => afterWrite(await taskApi.patch(tk.id, { priority: Number(e.target.value) }))}
                        >
                          {[4, 3, 2, 1, 0].map((p) => (
                            <option key={p} value={p}>
                              {prioLabel(p)}
                            </option>
                          ))}
                        </select>
                      </span>
                      <span className="pm-col-due">
                        <input
                          type="date"
                          className={`pm-date${!tk.done && dayOf(tk.due_at, tz) && dayOf(tk.due_at, tz)! < today ? ' late' : ''}`}
                          value={dayOf(tk.due_at, tz) ?? ''}
                          aria-label={t('Fällig: {title}', { title: tk.title })}
                          onChange={async (e) => afterWrite(await taskApi.dates(tk.id, { due: e.target.value || null }))}
                        />
                      </span>
                      <span className="pm-col-est muted small">{tk.estimate_minutes ? fmtMinutes(tk.estimate_minutes) : ''}</span>
                    </div>
                  ))}
                  {!rows.length && b.label && <div className="pm-group-empty muted small">{t('Keine Aufgaben')}{b.patch ? t(' – hierher ziehen oder unten hinzufügen') : ''}</div>}
                  <div className="pm-group-add">
                    <QuickAdd
                      small
                      tour={b === model.buckets[0] ? 'pm-quick-add' : undefined}
                      placeholder={b.label ? t('Aufgabe zu „{label}“ hinzufügen…', { label: b.label }) : t('Aufgabe hinzufügen…')}
                      onAdd={async (title) => afterWrite(await taskApi.create({ title, project_id: project.id, ...b.defaults }))}
                    />
                  </div>
                </>
              )}
            </div>
          );
        })}
        {!model.count && (
          <p className="pm-empty muted">{filtered ? t('Keine Aufgabe passt zu den Filtern.') : t('Noch keine Aufgaben in diesem Projekt.')}</p>
        )}
      </div>

      {selected.size > 0 && (
        <div className="pm-bulk" role="toolbar" aria-label={t('Sammelbearbeitung')} data-tour="pm-bulk">
          <strong>{selected.size} {t('ausgewählt')}</strong>
          <select aria-label={t('Status setzen')} value="" onChange={(e) => e.target.value && bulk({ patch: { status_id: e.target.value } }, t('Status gesetzt'))}>
            <option value="">{t('Status…')}</option>
            {project.statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select aria-label={t('Person hinzufügen')} value="" onChange={(e) => e.target.value && bulk({ patch: { add_assignees: [e.target.value] } }, t('Zugewiesen'))}>
            <option value="">{t('Zuweisen…')}</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select aria-label={t('Priorität setzen')} value="" onChange={(e) => e.target.value !== '' && bulk({ patch: { priority: Number(e.target.value) } }, t('Priorität gesetzt'))}>
            <option value="">{t('Priorität…')}</option>
            {[4, 3, 2, 1, 0].map((p) => (
              <option key={p} value={p}>
                {prioLabel(p)}
              </option>
            ))}
          </select>
          <select aria-label={t('Abschnitt setzen')} value="" onChange={(e) => e.target.value && bulk({ patch: { section_id: e.target.value === '-' ? null : e.target.value } }, t('Abschnitt gesetzt'))}>
            <option value="">{t('Abschnitt…')}</option>
            <option value="-">{t('Kein Abschnitt')}</option>
            {project.sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <label className="pm-bulk-date">
            <span className="sr-only">{t('Fälligkeitsdatum setzen')}</span>
            <input type="date" aria-label={t('Fälligkeitsdatum setzen')} onChange={(e) => e.target.value && bulk({ patch: { due_at: e.target.value } }, t('Fälligkeit gesetzt'))} />
          </label>
          <BulkTag onAdd={(tag) => bulk({ add_tags: [tag] }, t('Tag hinzugefügt'))} />
          <button
            type="button"
            className="btn small danger"
            onClick={() => confirmAsk(t.plural(selected.size, { other: '{n} Aufgaben löschen?' })) && bulk({ action: 'delete' }, t('Gelöscht'))}
          >
            <Icon name="trash" size={13} /> {t('Löschen')}
          </button>
          <button type="button" className="btn small secondary" onClick={() => select(new Set())}>
            {t('Auswahl aufheben')}
          </button>
        </div>
      )}
    </div>
  );
}

function BulkTag({ onAdd }: { onAdd: (tag: string) => void }) {
  const t = useT('pm');
  const [v, setV] = useState<string[]>([]);
  return (
    <span className="pm-bulk-tag">
      <TagInput
        value={v}
        placeholder={t('+ Tag')}
        onChange={(next) => {
          const added = next.find((x) => !v.includes(x));
          if (added) onAdd(added);
          setV([]);
        }}
      />
    </span>
  );
}

