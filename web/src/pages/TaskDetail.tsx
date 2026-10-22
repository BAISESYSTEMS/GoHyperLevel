import { useEffect, useState } from 'react';
import { api, name } from '../api';
import { Check, Field, Input, Link, Textarea, act } from '../ui';
import { dayOf } from './pm-format';
import { useT } from '../i18n';

/**
 * The task next to the list (iPad, a foldable unfolded – web/src/ios/MasterDetail.tsx): title, description, due date, done, contact.
 * Each field saves when it loses the focus, a tick and the date save at once. In a narrow window it replaces the list ("‹ Aufgaben").
 */
export function TaskDetail({ task, tz, onChanged, onGone, onBack }: { task: any; tz: string; onChanged: (tk: any) => void; onGone: () => void; onBack: () => void }) {
  const t = useT('pm');
  const [title, setTitle] = useState(task.title ?? '');
  const [desc, setDesc] = useState(task.description ?? '');
  useEffect(() => {
    setTitle(task.title ?? '');
    setDesc(task.description ?? '');
  }, [task.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (patch: Record<string, unknown>) => {
    const r = await act(() => api.patch(`/api/tasks/${task.id}`, patch));
    if (r) onChanged({ ...task, ...r });
  };
  return (
    <div className="card task-detail" data-tour="task-detail">
      <div className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
        <button className="btn small secondary md-back" onClick={onBack} aria-label={t('Zurück zur Liste')}>
          {t('‹ Aufgaben')}
        </button>
        <h2 style={{ margin: 0 }}>{t('Aufgabe')}</h2>
      </div>
      <Check checked={!!task.done} onChange={(v) => void save({ done: v })} label={task.done ? t('Erledigt') : t('Als erledigt markieren')} />
      <Field label={t('Titel')}>
        <Input value={title} onChange={setTitle} onBlur={() => title.trim() && title !== task.title && void save({ title: title.trim() })} />
      </Field>
      <Field label={t('Beschreibung')}>
        <Textarea value={desc} onChange={setDesc} onBlur={() => desc !== (task.description ?? '') && void save({ description: desc })} />
      </Field>
      <Field label={t('Fällig am')}>
        <Input type="date" value={task.due_at ? dayOf(task.due_at, tz) : ''} onChange={(v) => void save({ due_at: v ? new Date(v).toISOString() : null })} />
      </Field>
      {task.contact_id && (
        <p>
          {t('Kontakt:')} <Link to={`contacts/${task.contact_id}`}>{name(task)}</Link>
        </p>
      )}
      <button
        className="btn danger"
        onClick={async () => {
          if (await act(() => api.del(`/api/tasks/${task.id}`))) onGone();
        }}
      >
        {t('Aufgabe löschen')}
      </button>
    </div>
  );
}
