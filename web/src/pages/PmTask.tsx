import { useEffect, useState } from 'react';
import { api, dt } from '../api';
import { Icon } from '../icons';
import { Modal, TagInput, act, confirmAsk, toast, useLoad } from '../ui';
import { AssociationsPanel } from './ObjectKit';
import {
  ActivityList,
  AttachmentsPanel,
  ChecklistsPanel,
  CommentsPanel,
  DependenciesPanel,
  RecurrenceEditor,
  TimePanel,
  newChecklist,
  type Activity,
  type Attachment,
  type Comment,
  type Deps,
} from './PmTaskParts';
import { Avatar, DueChip, FieldInput, LinkPicker, PRIORITY_COLORS, prioLabel, PeoplePicker, ProjectDot, QuickAdd, StatusSelect, dayOf, fmtHM, fmtMinutes, parseDuration, taskApi, todayIn, usePmMeta, type FieldDef, type Project, type Section, type Status, type Task } from './PmKit';
import { useT } from '../i18n';

/** The task window: everything about one task in one place (opened by ?task=<id> in any view). */

interface Detail {
  task: Task;
  subtasks: Task[];
  trail: { id: string; title: string }[];
  comments: Comment[];
  attachments: Attachment[];
  dependencies: Deps;
  activity: Activity[];
  project: { id: string; name: string; color: string; skip_weekends: boolean; billable: boolean };
  statuses: Status[];
  sections: Section[];
  fields: FieldDef[];
}

function Prop({ label, children, tour }: { label: string; children: React.ReactNode; tour?: string }) {
  return (
    <div className="pm-prop" data-tour={tour}>
      <span className="pm-prop-label">{label}</span>
      <div className="pm-prop-body">{children}</div>
    </div>
  );
}

function TextDraft({ value, onSave, className, placeholder, label, multiline }: { value: string; onSave: (v: string) => void; className?: string; placeholder?: string; label: string; multiline?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const done = () => v !== value && onSave(v);
  return multiline ? (
    <textarea className={className} value={v} placeholder={placeholder} aria-label={label} rows={4} onChange={(e) => setV(e.target.value)} onBlur={done} />
  ) : (
    <input
      className={className}
      value={v}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => setV(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
        if (e.key === 'Escape' && v !== value) (e.stopPropagation(), setV(value));
      }}
    />
  );
}

export function TaskModal({ id, onClose, onChanged, openTask }: { id: string; onClose: () => void; onChanged: () => void; openTask: (id: string | null) => void }) {
  const t = useT('pm');
  const meta = usePmMeta();
  const d = useLoad(() => api.get<Detail>(`/api/pm/tasks/${id}`), [id]);
  const projects = useLoad(() => api.get<Project[]>('/api/pm/projects'), []);
  const [tab, setTab] = useState<'comments' | 'activity' | 'time'>('comments');
  const [estimate, setEstimate] = useState('');
  const tk = d.data?.task;
  useEffect(() => setEstimate(tk?.estimate_minutes ? fmtMinutes(tk.estimate_minutes) : ''), [tk?.estimate_minutes, tk?.id]);

  if (d.error && !d.data)
    return (
      <Modal title={t('Aufgabe')} onClose={onClose}>
        <p className="pm-error">{d.error}</p>
      </Modal>
    );
  if (!d.data || !tk || !meta)
    return (
      <Modal title={t('Aufgabe')} onClose={onClose} wide className="pm-task-modal">
        <div className="pm-loading">{t('Lädt…')}</div>
      </Modal>
    );

  const { project, statuses, sections, fields, subtasks, dependencies, trail } = d.data;
  const tz = meta.timezone;
  const today = todayIn(tz);
  const refresh = async () => {
    await d.reload();
    onChanged();
  };
  const save = async (patch: Record<string, unknown>) => {
    const r = await taskApi.patch(id, patch);
    if (r) await refresh();
    return r;
  };
  const dates = async (patch: { start?: string | null; due?: string | null }) => {
    const r = await taskApi.dates(id, patch);
    if (r) await refresh();
  };
  const start = dayOf(tk.start_at, tz) ?? '';
  const due = dayOf(tk.due_at, tz) ?? '';
  const open = (tid: string) => openTask(tid);
  const estimatePct = tk.estimate_minutes ? Math.min(100, Math.round((tk.logged_seconds / 60 / tk.estimate_minutes) * 100)) : 0;

  return (
    <Modal title={project.name} onClose={onClose} wide className="pm-task-modal">
      <div className="pm-task" data-tour="pm-task">
        <div className="pm-task-main">
          {trail.length > 0 && (
            <nav className="pm-trail" aria-label={t('Übergeordnete Aufgaben')}>
              {trail.map((p) => (
                <button type="button" key={p.id} className="pm-link" onClick={() => open(p.id)}>
                  {p.title}
                </button>
              ))}
              <span className="muted">›</span>
            </nav>
          )}
          <div className="pm-task-titlerow">
            <input
              type="checkbox"
              className="pm-bigcheck"
              checked={tk.done}
              aria-label={tk.done ? t('Wieder öffnen') : t('Als erledigt markieren')}
              onChange={(e) => save({ done: e.target.checked })}
              data-tour="pm-task-done"
            />
            <TextDraft className={`pm-task-title${tk.done ? ' done' : ''}`} value={tk.title} label={t('Titel')} onSave={(v) => (v.trim() ? save({ title: v.trim() }) : refresh())} />
          </div>
          {tk.blocked && (
            <div className="pm-note warn" role="status">
              <Icon name="lock" size={13} /> {t('Wartet auf eine noch nicht erledigte Aufgabe.')}
            </div>
          )}
          <TextDraft multiline className="pm-desc" value={tk.description} label={t('Beschreibung')} placeholder={t('Beschreibung hinzufügen…')} onSave={(v) => save({ description: v })} />

          <section className="pm-sec" data-tour="pm-subtasks">
            <h4>
              {t('Unteraufgaben')} {tk.subtasks.total > 0 && <span className="muted small">{tk.subtasks.done}/{tk.subtasks.total}</span>}
            </h4>
            {tk.subtasks.total > 0 && (
              <div className="pm-bar-track" aria-hidden="true">
                <i style={{ width: `${(tk.subtasks.done / tk.subtasks.total) * 100}%` }} />
              </div>
            )}
            {subtasks.map((s) => (
              <div key={s.id} className="pm-subtask">
                <input type="checkbox" checked={s.done} aria-label={t('{title} erledigt', { title: s.title })} onChange={async (e) => (await taskApi.patch(s.id, { done: e.target.checked })) && refresh()} />
                <button type="button" className={`pm-link grow${s.done ? ' done' : ''}`} onClick={() => open(s.id)}>
                  {s.title}
                </button>
                {s.subtasks.total > 0 && (
                  <span className="muted small">
                    {s.subtasks.done}/{s.subtasks.total}
                  </span>
                )}
                {s.assignees.slice(0, 2).map((a) => (
                  <Avatar key={a.id} person={a} size={20} />
                ))}
                <DueChip task={s} tz={tz} today={today} />
              </div>
            ))}
            <QuickAdd
              small
              placeholder={t('Unteraufgabe hinzufügen…')}
              onAdd={async (title) => {
                const r = await taskApi.create({ title, project_id: tk.project_id, parent_id: tk.id });
                if (r) await refresh();
              }}
            />
          </section>

          <ChecklistsPanel value={tk.checklists} onSave={(next) => save({ checklists: next })} />
          <button type="button" className="btn small secondary pm-add-check" onClick={() => save({ checklists: [...tk.checklists, newChecklist()] })}>
            <Icon name="features" size={13} /> {t('Checkliste hinzufügen')}
          </button>

          <DependenciesPanel task={tk} deps={dependencies} meta={meta} tz={tz} onChange={refresh} openTask={open} />
          <AttachmentsPanel task={tk} items={d.data.attachments} maxBytes={meta.max_file_bytes} onChange={refresh} />

          <div className="pm-task-tabs tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'comments'} className={tab === 'comments' ? 'on' : ''} onClick={() => setTab('comments')} data-tour="pm-tab-comments">
              {t('Kommentare')} {d.data.comments.length > 0 && <span className="muted small">{d.data.comments.length}</span>}
            </button>
            <button role="tab" aria-selected={tab === 'time'} className={tab === 'time' ? 'on' : ''} onClick={() => setTab('time')} data-tour="pm-tab-time">
              {t('Zeit')} {tk.logged_seconds > 0 && <span className="muted small">{fmtHM(tk.logged_seconds)}</span>}
            </button>
            <button role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')} data-tour="pm-tab-activity">
              {t('Aktivität')}
            </button>
          </div>
          {tab === 'comments' && <CommentsPanel task={tk} comments={d.data.comments} team={meta.team} me={meta.me.id} manager={meta.me.manager} onChange={refresh} />}
          {tab === 'time' && <TimePanel task={tk} billable={project.billable} tz={tz} onChange={refresh} />}
          {tab === 'activity' && <ActivityList items={d.data.activity} tz={tz} />}
        </div>

        <aside className="pm-task-side" aria-label={t('Eigenschaften')}>
          <Prop label="Status" tour="pm-task-status">
            <StatusSelect statuses={statuses} value={tk.status_id} onChange={(sid) => save({ status_id: sid })} />
          </Prop>
          <Prop label={t('Zuständig')} tour="pm-task-assignees">
            <PeoplePicker team={meta.team} value={tk.assignees.map((a) => a.id)} onChange={(ids) => save({ assignees: ids })} />
          </Prop>
          <Prop label={t('Beobachter')}>
            <PeoplePicker team={meta.team} label={t('Beobachter')} value={tk.watchers} onChange={(ids) => save({ watchers: ids })} empty={t('Niemand')} />
          </Prop>
          <Prop label={t('Priorität')}>
            <select value={tk.priority} onChange={(e) => save({ priority: Number(e.target.value) })} aria-label={t('Priorität')} style={{ color: PRIORITY_COLORS[tk.priority] }}>
              {[4, 3, 2, 1, 0].map((p) => (
                <option key={p} value={p}>
                  {prioLabel(p)}
                </option>
              ))}
            </select>
          </Prop>
          <Prop label={t('Start')} tour="pm-task-dates">
            <input type="date" value={start} max={due || undefined} onChange={(e) => dates({ start: e.target.value || null })} aria-label={t('Start')} />
          </Prop>
          <Prop label={t('Fällig')}>
            <input type="date" value={due} min={start || undefined} onChange={(e) => dates({ due: e.target.value || null })} aria-label={t('Fällig')} />
          </Prop>
          <Prop label={t('Meilenstein')}>
            <label className="check">
              <input type="checkbox" checked={tk.milestone} onChange={(e) => save({ milestone: e.target.checked })} /> {t('Tag ohne Dauer (◆ im Gantt)')}
            </label>
          </Prop>
          <Prop label={t('Schätzung')} tour="pm-task-estimate">
            <input
              value={estimate}
              placeholder={t('z. B. 2h oder 1:30')}
              aria-label={t('Geschätzter Aufwand')}
              onChange={(e) => setEstimate(e.target.value)}
              onBlur={() => {
                const m = parseDuration(estimate);
                if (estimate.trim() && m === null) return toast(t('Aufwand bitte als „2h“, „1:30“ oder „45m“ angeben'));
                if ((m ?? null) !== (tk.estimate_minutes ?? null)) void save({ estimate_minutes: m });
              }}
            />
            {tk.estimate_minutes ? (
              <div className="pm-estimate">
                <div className="pm-bar-track" aria-hidden="true">
                  <i style={{ width: `${estimatePct}%`, background: tk.logged_seconds / 60 > tk.estimate_minutes ? 'var(--red)' : undefined }} />
                </div>
                <span className="muted small">
                  {fmtHM(tk.logged_seconds)} {t('von')} {fmtMinutes(tk.estimate_minutes)} {t('erfasst')}
                </span>
              </div>
            ) : null}
          </Prop>
          <Prop label={t('Abschnitt')}>
            <select value={tk.section_id ?? ''} onChange={(e) => save({ section_id: e.target.value || null })} aria-label={t('Abschnitt')}>
              <option value="">{t('Kein Abschnitt')}</option>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Prop>
          <Prop label="Tags">
            <TagInput value={tk.tags} onChange={(v) => save({ tags: v })} />
          </Prop>
          <Prop label={t('Wiederholung')}>
            <RecurrenceEditor value={tk.recurrence} onChange={(r) => save({ recurrence: r })} />
          </Prop>
          <Prop label={t('Kunde')}>
            <LinkPicker type="contact" label={t('Kontakt')} value={tk.contact_id ? { id: tk.contact_id, name: tk.contact_name || t('Kontakt') } : null} onChange={(v) => save({ contact_id: v?.id ?? null })} />
          </Prop>
          <Prop label={t('Projekt')}>
            <select value={tk.project_id ?? ''} onChange={(e) => e.target.value !== tk.project_id && save({ project_id: e.target.value })} aria-label={t('Projekt')}>
              {(projects.data ?? [{ id: project.id, name: project.name } as Project]).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Prop>
          <Prop label={t('Sichtbarkeit')}>
            <label className="check">
              <input type="checkbox" checked={tk.internal} onChange={(e) => save({ internal: e.target.checked })} /> {t('Nur intern (im Kundenportal verborgen)')}
            </label>
          </Prop>
          {fields.map((f) => (
            <Prop key={f.id} label={f.label}>
              <FieldInput def={f} value={tk.custom[f.key]} onChange={(v) => save({ custom: { ...tk.custom, [f.key]: v } })} />
            </Prop>
          ))}
          <div className="pm-side-assoc" data-tour="pm-task-links">
            <AssociationsPanel type="task" id={tk.id} compact title={t('Verknüpfungen')} />
          </div>
          <div className="pm-side-actions">
            <button
              type="button"
              className="btn small secondary"
              onClick={async () => {
                const r = await act(() => api.post<Task>(`/api/pm/tasks/${tk.id}/duplicate`, {}), t('Dupliziert'));
                if (r) (onChanged(), open(r.id));
              }}
            >
              <Icon name="copy" size={13} /> {t('Duplizieren')}
            </button>
            <button
              type="button"
              className="btn small secondary"
              onClick={async () => {
                const data = { title: tk.title, description: tk.description, priority: tk.priority, tags: tk.tags, estimate_minutes: tk.estimate_minutes ?? undefined, checklist: tk.checklists.map((c) => ({ title: c.title, items: c.items.map((i) => i.text) })), subtasks: subtasks.map((s) => s.title) };
                await act(() => api.post('/api/pm/templates', { name: tk.title, data }), t('Als Aufgabenvorlage gespeichert'));
              }}
            >
              <Icon name="template" size={13} /> {t('Als Vorlage')}
            </button>
            <button
              type="button"
              className="btn small danger"
              onClick={async () => {
                if (!confirmAsk(tk.subtasks.total ? t('Aufgabe mit allen Unteraufgaben löschen?') : t('Aufgabe löschen?'))) return;
                if (await taskApi.remove(tk.id)) (onChanged(), onClose());
              }}
            >
              <Icon name="trash" size={13} /> {t('Löschen')}
            </button>
          </div>
          <p className="muted small pm-meta">
            {t('Angelegt')} {dt(tk.created_at)}
            {tk.updated_at ? t(' · geändert {date}', { date: dt(tk.updated_at) }) : ''}
            {project.billable ? '' : t(' · Projekt nicht abrechenbar')}
          </p>
          <p className="muted small">
            <ProjectDot color={project.color} /> {project.name}
          </p>
        </aside>
      </div>
    </Modal>
  );
}
