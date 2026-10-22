import { useEffect, useRef, useState } from 'react';
import { api, ago } from '../api';
import { Icon } from '../icons';
import { Link, act, navigate } from '../ui';
import { Pop, fmtHMS, useTick } from './PmKit';
import { useT } from '../i18n';

/** Topbar of the app: the running timer (wherever it was started) and the planner's notifications. */

interface Running {
  id: string;
  task_id: string | null;
  task_title: string;
  project_name: string;
  started_at: string;
  location_name: string;
  other_location: boolean;
}
interface Note {
  id: string;
  kind: string;
  title: string;
  body: string;
  task_id: string | null;
  link?: string;
  read_at: string | null;
  created_at: string;
}

const ICONS: Record<string, string> = { mention: 'chat', assigned: 'contact', due: 'schedule', overdue: 'flag', comment: 'chat', status: 'ok', timer: 'wait', timesheet: 'schedule', watch: 'opened', budget: 'price', approval: 'shield' };

function Clock({ since }: { since: string }) {
  useTick(1000);
  return <span className="pm-chip-time">{fmtHMS((Date.now() - Date.parse(since)) / 1000)}</span>;
}

function TimerChip() {
  const t = useT('shell');
  const [run, setRun] = useState<Running | null | undefined>();
  const load = () => api.get<{ running: Running | null }>('/api/pm/timer').then((r) => setRun(r.running), () => undefined);
  useEffect(() => {
    void load();
    const on = () => void load();
    window.addEventListener('pm:timer', on);
    window.addEventListener('focus', on);
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), 60_000);
    return () => {
      window.removeEventListener('pm:timer', on);
      window.removeEventListener('focus', on);
      clearInterval(t);
    };
  }, []);
  if (!run)
    return (
      <Link to="time" className="btn secondary small pm-chip-idle" tour="pm-timer-chip" label={t('Zeiterfassung')}>
        <Icon name="schedule" size={14} /> <span>{t('Zeit')}</span>
      </Link>
    );
  const title = run.task_title || run.project_name || t('Zeiterfassung');
  return (
    <span className="pm-chip" data-tour="pm-timer-chip" role="status" aria-label={t('Timer läuft: {title}', { title })}>
      <i className="pm-chip-dot" aria-hidden="true" />
      <Link to={run.task_id && !run.other_location ? `pm/task/${run.task_id}` : 'time'} className="pm-chip-link">
        <Clock since={run.started_at} />
        <span className="pm-chip-title">
          {title}
          {run.other_location ? ` · ${run.location_name}` : ''}
        </span>
      </Link>
      <button
        type="button"
        className="pm-chip-stop"
        aria-label={t('Timer stoppen')}
        title={t('Timer stoppen')}
        onClick={async () => {
          if (await act(() => api.post('/api/pm/timer/stop', {}))) (setRun(null), window.dispatchEvent(new Event('pm:timer')));
        }}
      >
        <Icon name="end" size={15} />
      </button>
    </span>
  );
}

function Bell() {
  const t = useT('shell');
  const [data, setData] = useState<{ unread: number; items: Note[] }>({ unread: 0, items: [] });
  const load = () => api.get<{ unread: number; items: Note[] }>('/api/pm/notifications?limit=20').then(setData, () => undefined);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      void load();
    }
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), 60_000);
    const on = () => void load();
    window.addEventListener('focus', on);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', on);
    };
  }, []);
  return (
    <Pop
      label={data.unread ? t.plural(data.unread, { one: '{n} ungelesene Benachrichtigung', other: '{n} ungelesene Benachrichtigungen' }) : t('Benachrichtigungen')}
      width={340}
      className="pm-bell"
      button={
        <>
          <Icon name="notify" size={17} />
          {data.unread > 0 && <b className="pm-bell-n">{data.unread > 9 ? '9+' : data.unread}</b>}
        </>
      }
    >
      {(close) => (
        <div className="pm-notes" data-tour="pm-notifications">
          <div className="pm-notes-head">
            <strong>{t('Benachrichtigungen')}</strong>
            {data.unread > 0 && (
              <button
                type="button"
                className="btn small ghost"
                onClick={async () => {
                  if (await act(() => api.post('/api/pm/notifications/read', { all: true }))) void load();
                }}
              >
                {t('Alle gelesen')}
              </button>
            )}
          </div>
          {data.items.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`pm-note-item${n.read_at ? '' : ' unread'}`}
              onClick={async () => {
                if (!n.read_at) await api.post('/api/pm/notifications/read', { ids: [n.id] }).catch(() => undefined);
                close();
                void load();
                if (n.task_id) navigate(`pm/task/${n.task_id}`);
                else if (n.link?.startsWith('/app/')) navigate(n.link.slice(5));
              }}
            >
              <Icon name={(ICONS[n.kind] ?? 'notify') as any} size={15} />
              <span className="grow">
                <strong>{n.title}</strong>
                {n.body && <span className="muted small">{n.body}</span>}
                <span className="muted small">{ago(n.created_at)}</span>
              </span>
            </button>
          ))}
          {!data.items.length && <p className="muted small" style={{ padding: 12 }}>{t('Nichts Neues. Hier erscheinen Erwähnungen, Zuweisungen und Fristen.')}</p>}
        </div>
      )}
    </Pop>
  );
}

export function PmTopbar() {
  return (
    <>
      <TimerChip />
      <Bell />
    </>
  );
}
