import { useState } from 'react';
import { api, d, name } from '../api';
import { Check, Empty, Input, Link, PageHead, Spinner, Tabs, act, useLoad } from '../ui';
import { MasterDetail } from '../ios/MasterDetail';
import { useSession } from '../session';
import { TaskDetail } from './TaskDetail';
import { dayOf, todayIn } from './pm-format';
import '../undo/undo.css';
import { useT } from '../i18n';

export function Tasks() {
  const t = useT('pm');
  const [status, setStatus] = useState('open');
  // "Erledigt heute": what was ticked off today, one click away (and undoable from the toast).
  const list = useLoad(() => api.get<any[]>(status === 'today' ? '/api/undo/done-today' : `/api/tasks?status=${status}`), [status]);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  // "Today" is the sub-account's date (a task due yesterday turns red after midnight there, not after midnight UTC).
  const session = useSession();
  const tz = session.locations.find((l) => l.id === session.locationId)?.timezone ?? 'Europe/Berlin';
  const today = todayIn(tz);
  // The task shown next to the list on a wide window (iPad); in a narrow one it replaces the list.
  const [sel, setSel] = useState<any>(null);
  const cur = sel && (list.data?.find((tk) => tk.id === sel.id) ?? sel);
  const listPane = (
    <>
      <PageHead title={t('Aufgaben')}>
        <Link to="pm/my" className="btn secondary">
          {t('Projektplanung öffnen')}
        </Link>
      </PageHead>
      <div className="card row" style={{ marginBottom: 12 }} data-tour="tasks-new">
        <div className="grow" data-tour="tasks-title">
          <Input value={title} onChange={setTitle} placeholder={t('Neue Aufgabe…')} />
        </div>
        <div style={{ width: 170 }}>
          <Input type="date" value={due} onChange={setDue} aria-label={t('Fällig am')} />
        </div>
        <button className="btn" data-tour="tasks-add" disabled={!title} onClick={() => act(() => api.post('/api/tasks', { title, due_at: due ? new Date(due).toISOString() : null })).then(() => (setTitle(''), setDue(''), list.reload()))}>
          {t('Hinzufügen')}
        </button>
      </div>
      <Tabs tabs={[['open', t('Offen')], ['today', t('Erledigt heute')], ['done', t('Erledigt')], ['all', t('Alle')]]} value={status} onChange={setStatus} />
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.data?.length ? (
        <div className="card" data-tour="tasks-list">
          {list.data.map((tk) => (
            <div key={tk.id} className={`row task-row${tk.id === cur?.id ? ' on' : ''}`} style={{ alignItems: 'center', borderBottom: '1px solid var(--line)', padding: '4px 0' }}>
              <div className="grow">
                <Check
                  checked={!!tk.done}
                  onChange={(v) => act(() => api.patch(`/api/tasks/${tk.id}`, { done: v })).then(list.reload)}
                  label={
                    <span style={{ textDecoration: tk.done ? 'line-through' : '' }}>
                      {tk.title} {tk.contact_id && <Link to={`contacts/${tk.contact_id}`}>· {name(tk)}</Link>}
                    </span>
                  }
                />
              </div>
              {tk.due_at && <span style={{ color: !tk.done && dayOf(tk.due_at, tz)! < today ? 'var(--red)' : 'var(--muted)' }}>{d(tk.due_at)}</span>}
              <button className="icon-btn" onClick={() => setSel(tk)} aria-label={t('Details')} aria-pressed={tk.id === cur?.id} data-tour="task-open">
                ›
              </button>
              <button className="icon-btn" onClick={() => act(() => api.del(`/api/tasks/${tk.id}`)).then(() => (tk.id === sel?.id && setSel(null), list.reload()))} aria-label={t('Löschen')}>
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : (
        <Empty>{status === 'today' ? t('Heute ist noch nichts erledigt.') : t('Nichts zu tun – alles erledigt.')}</Empty>
      )}
    </>
  );
  return (
    <MasterDetail
      open={!!cur}
      list={listPane}
      detail={cur && <TaskDetail task={cur} tz={tz} onChanged={(tk) => (setSel(tk), list.reload())} onGone={() => (setSel(null), list.reload())} onBack={() => setSel(null)} />}
      empty={t('Tippe bei einer Aufgabe auf ›, um Details zu sehen.')}
    />
  );
}
