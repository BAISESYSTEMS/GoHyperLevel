import { api } from '../api';
import { Field, Input, Select, Textarea, useLoad } from '../ui';
import { prioLabel, type Person, type Project, type Status } from './PmKit';
import { useT } from '../i18n';

/** Workflow editor parts for the planner: filters of the `task.*` triggers and the steps pm_create_task / pm_move_task / pm_assign_task. */

// German labels (message ids of the pm catalog), shown through t()
const CATEGORIES: [string, string][] = [
  ['todo', 'Zu erledigen'],
  ['active', 'In Arbeit'],
  ['done', 'Erledigt'],
];

const usePeople = () => useLoad(() => api.get<Person[]>('/api/pm/team'), []).data ?? [];
const useProjects = () => useLoad(() => api.get<Project[]>('/api/pm/projects'), []).data ?? [];

/** Filters of task.created / task.status_changed / task.overdue / task.assigned / task.completed. */
export function PmTriggerFilter({ type, config, set }: { type: string; config: Record<string, any>; set: (patch: Record<string, any>) => void }) {
  const t = useT('pm');
  const projects = useProjects();
  const people = usePeople();
  const statuses = useLoad(() => (config.project_id ? api.get<Status[]>(`/api/pm/projects/${config.project_id}/statuses`) : Promise.resolve([] as Status[])), [config.project_id]).data ?? [];
  return (
    <>
      <Field label={t('Nur in Projekt (optional)')}>
        <Select value={config.project_id} onChange={(v) => set({ project_id: v, status_id: '' })} placeholder={t('jedes Projekt')} options={projects.map((p) => [p.id, p.name])} />
      </Field>
      {type === 'task.status_changed' && (
        <div className="grid2">
          <Field label={t('Neuer Status (optional)')}>
            <Select value={config.status_id} onChange={(v) => set({ status_id: v })} placeholder={config.project_id ? t('egal') : t('erst ein Projekt wählen')} options={statuses.map((s) => [s.id, s.name])} />
          </Field>
          <Field label={t('Oder Kategorie')}>
            <Select value={config.category} onChange={(v) => set({ category: v })} placeholder={t('egal')} options={CATEGORIES.map(([k, l]) => [k, t(l)] as [string, string])} />
          </Field>
        </div>
      )}
      {type === 'task.assigned' && (
        <Field label={t('Nur wenn zugewiesen an (optional)')}>
          <Select value={config.user_id} onChange={(v) => set({ user_id: v })} placeholder={t('jede Person')} options={people.map((p) => [p.id, p.name])} />
        </Field>
      )}
    </>
  );
}

export function PmStepEditor({ step, set }: { step: Record<string, any>; set: (patch: Record<string, any>) => void }) {
  const t = useT('pm');
  const projects = useProjects();
  const people = usePeople();
  if (step.type === 'pm_create_task')
    return (
      <>
        <Field label={t('Titel')} hint={t('Platzhalter wie {{contact.first_name}} sind möglich')}>
          <Input value={step.title} onChange={(v) => set({ title: v })} />
        </Field>
        <Field label={t('Beschreibung')}>
          <Textarea value={step.description} onChange={(v) => set({ description: v })} />
        </Field>
        <div className="grid2">
          <Field label={t('Projekt')} hint={t('Leer = Projekt „Allgemein“')}>
            <Select value={step.project_id} onChange={(v) => set({ project_id: v })} placeholder={t('Allgemein')} options={projects.filter((p) => !p.is_default).map((p) => [p.id, p.name])} />
          </Field>
          <Field label={t('Zuständig')}>
            <Select value={step.assignee} onChange={(v) => set({ assignee: v })} placeholder={t('niemand')} options={people.map((p) => [p.id, p.name])} />
          </Field>
          <Field label={t('Fällig in (Tagen)')}>
            <Input type="number" value={step.due_in_days} onChange={(v) => set({ due_in_days: v })} />
          </Field>
          <Field label={t('Priorität')}>
            <Select value={String(step.priority ?? '')} onChange={(v) => set({ priority: v === '' ? undefined : Number(v) })} placeholder={t('Standard')} options={[4, 3, 2, 1, 0].map((p) => [String(p), prioLabel(p)])} />
          </Field>
        </div>
        <Field label={t('Unteraufgaben (eine pro Zeile)')}>
          <Textarea value={(step.subtasks ?? []).join('\n')} onChange={(v) => set({ subtasks: v.split('\n').map((x) => x.trim()).filter(Boolean) })} />
        </Field>
      </>
    );
  if (step.type === 'pm_move_task')
    return (
      <>
        <Field label={t('Aufgabe')} hint={t('Leer = die Aufgabe aus dem Auslöser (nur bei Aufgaben-Auslösern)')}>
          <Input value={step.task_id} onChange={(v) => set({ task_id: v })} placeholder="{{event.task.id}}" />
        </Field>
        <div className="grid2">
          <Field label={t('Status (Name im Projekt)')}>
            <Input value={step.status} onChange={(v) => set({ status: v, category: '' })} placeholder={t('z. B. In Prüfung')} />
          </Field>
          <Field label={t('Oder Kategorie')}>
            <Select value={step.category} onChange={(v) => set({ category: v, status: '' })} placeholder="–" options={CATEGORIES.map(([k, l]) => [k, t(l)] as [string, string])} />
          </Field>
        </div>
      </>
    );
  return (
    <>
      <Field label={t('Aufgabe')} hint={t('Leer = die Aufgabe aus dem Auslöser (nur bei Aufgaben-Auslösern)')}>
        <Input value={step.task_id} onChange={(v) => set({ task_id: v })} placeholder="{{event.task.id}}" />
      </Field>
      <div className="grid2">
        <Field label={t('Person')}>
          <Select value={step.user_id} onChange={(v) => set({ user_id: v })} placeholder={t('wählen…')} options={people.map((p) => [p.id, p.name])} />
        </Field>
        <Field label={t('Wie')}>
          <Select value={step.mode ?? 'add'} onChange={(v) => set({ mode: v })} options={[['add', t('Zusätzlich zuweisen')], ['set', t('Als einzige Person zuweisen')]]} />
        </Field>
      </div>
    </>
  );
}
