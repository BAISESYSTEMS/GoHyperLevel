import { useEffect, useState } from 'react';
import { api, d as day, dt } from '../api';
import { Badge, Empty, Field, Input, Modal, PageHead, Select, Spinner, act, confirmAsk, navigate, useLoad } from '../ui';
import { Icon } from '../icons';
import { DashboardView, ScheduleForm } from './ReportDashboard';
import { ReportBuilder } from './ReportBuilder';
import { VISIBILITY, VIZ_LIST, useReportMeta, type Meta } from './ReportKit';
import { useT } from '../i18n';

/**
 * Berichte: dashboards (default first), report builder, library of saved reports, e-mail schedules
 * and dashboard templates. Routes: /app/reports, /reports/d/:id, /reports/new, /reports/r/:id,
 * /reports/library, /reports/schedules, /reports/templates.
 */

function Templates({ onCreated }: { onCreated?: () => void }) {
  const t = useT('reports');
  const { data } = useLoad(() => api.get('/api/reports/templates'));
  const [busy, setBusy] = useState('');
  if (!data) return <Spinner />;
  return (
    <div className="rpt-templates" data-tour="reports-templates">
      {data.map((tpl: any) => (
        <div key={tpl.key} className="card rpt-template">
          {/* the templates come from the server (services/report-templates.ts) in German */}
          <h3>{t(tpl.name)}</h3>
          <p className="muted small">{t(tpl.description)}</p>
          <ul>
            {tpl.widgets.slice(0, 5).map((w: string) => (
              <li key={w}>{t(w)}</li>
            ))}
            {tpl.widgets.length > 5 && <li className="muted">+ {tpl.widgets.length - 5} {t('weitere')}</li>}
          </ul>
          <button
            className="btn small"
            data-tour="report-template-use"
            disabled={!!busy}
            onClick={async () => {
              setBusy(tpl.key);
              const r = await act(() => api.post(`/api/reports/templates/${tpl.key}`, {}), t('Dashboard „{name}“ erstellt', { name: t(tpl.name) }));
              setBusy('');
              if (r) {
                onCreated?.();
                navigate(`reports/d/${r.id}`);
              }
            }}
          >
            {busy === tpl.key ? t('Wird erstellt …') : t('Dashboard aus Vorlage')}
          </button>
        </div>
      ))}
    </div>
  );
}

function NewDashboard({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const t = useT('reports');
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState('private');
  return (
    <Modal
      title={t('Neues Dashboard')}
      onClose={onClose}
      footer={
        <button
          className="btn"
          disabled={!name.trim()}
          onClick={async () => {
            const r = await act(() => api.post('/api/reports/dashboards', { name, visibility, widgets: [] }));
            if (r) {
              onCreated();
              navigate(`reports/d/${r.id}`);
            }
          }}
        >
          {t('Anlegen')}
        </button>
      }
    >
      <Field label="Name">
        <Input value={name} onChange={setName} autoFocus placeholder={t('z. B. Wochenüberblick')} />
      </Field>
      <Field label={t('Sichtbar für')}>
        <Select value={visibility} onChange={setVisibility} options={VISIBILITY.map(([k, l]) => [k, t(l)] as [string, string])} />
      </Field>
      <p className="muted small">{t('Oder fertig aus einer Vorlage unter „Vorlagen“.')}</p>
    </Modal>
  );
}

function Dashboards({ id, meta }: { id?: string; meta: Meta }) {
  const t = useT('reports');
  const { data, reload } = useLoad(() => api.get('/api/reports/dashboards'));
  const [creating, setCreating] = useState(false);
  if (!data) return <Spinner />;
  const list: any[] = data.dashboards;
  const current = id ?? (list.some((x) => x.id === data.default_id) ? data.default_id : list[0]?.id);
  if (!current) {
    return (
      <>
        <Empty action={<button className="btn" onClick={() => setCreating(true)}>{t('Leeres Dashboard')}</button>}>{t('Noch keine eigenen Dashboards. Starte mit einer Vorlage – mit einem Klick fertig:')}</Empty>
        <Templates onCreated={reload} />
        {creating && <NewDashboard onClose={() => setCreating(false)} onCreated={reload} />}
      </>
    );
  }
  const switcher = (
    <div className="rpt-switcher">
      <select value={current} onChange={(e) => (e.target.value === '__new' ? setCreating(true) : navigate(`reports/d/${e.target.value}`))} aria-label={t('Dashboard wählen')}>
        {list.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
        <option value="__new">{t('+ Neues Dashboard …')}</option>
      </select>
    </div>
  );
  return (
    <>
      <DashboardView key={current} id={current} meta={meta} defaultId={data.default_id} onListChange={reload} switcher={switcher} />
      {creating && <NewDashboard onClose={() => setCreating(false)} onCreated={reload} />}
    </>
  );
}

function Library({ meta }: { meta: Meta }) {
  const t = useT('reports');
  const { data, reload } = useLoad(() => api.get('/api/reports/library'));
  if (!data) return <Spinner />;
  if (!data.length) return <Empty action={<button className="btn" onClick={() => navigate('reports/new')}>{t('Bericht erstellen')}</button>}>{t('Noch keine gespeicherten Berichte.')}</Empty>;
  const vizIcon = (v: string) => VIZ_LIST.find((x) => x[0] === v)?.[2] ?? 'vizTable';
  return (
    <div className="card" style={{ padding: 0 }}>
      <table className="t">
        <thead>
          <tr>
            <th>{t('Bericht')}</th>
            <th>{t('Quelle')}</th>
            <th>{t('Sichtbar')}</th>
            <th>{t('Geändert')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.map((r: any) => (
            <tr key={r.id}>
              <td>
                <a href={`/app/reports/r/${r.id}`} onClick={(e) => (e.preventDefault(), navigate(`reports/r/${r.id}`))}>
                  <Icon name={vizIcon(r.config.viz)} /> {r.name}
                </a>
                {r.description && <div className="muted small">{r.description}</div>}
              </td>
              <td>{meta.sources.find((s) => s.key === r.config.query.source)?.label ?? r.config.query.source}</td>
              <td>
                <Badge tone={r.visibility === 'private' ? 'gray' : 'blue'}>{t(VISIBILITY.find((v) => v[0] === r.visibility)?.[1] ?? '')}</Badge>
              </td>
              <td className="muted">{day(r.updated_at)}</td>
              <td style={{ textAlign: 'right' }}>
                {r.can_edit && (
                  <button className="icon-btn" aria-label={t('Löschen')} onClick={async () => confirmAsk(t('„{name}“ löschen?', { name: r.name })) && (await act(() => api.del(`/api/reports/library/${r.id}`), t('Gelöscht'))) && reload()}>
                    <Icon name="trash" />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Schedules() {
  const t = useT('reports');
  const { data, reload } = useLoad(() => api.get('/api/reports/schedules'));
  const [editing, setEditing] = useState<any>(null);
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  if (!data) return <Spinner />;
  const when = (s: any) => {
    const day = [t('Montag'), t('Dienstag'), t('Mittwoch'), t('Donnerstag'), t('Freitag'), t('Samstag'), t('Sonntag')][s.weekday - 1];
    const often = s.frequency === 'daily' ? t('Täglich') : s.frequency === 'weekly' ? t('Jeden {day}', { day }) : t('Am {n}. jeden Monats', { n: s.monthday });
    return t('{when}, {hour}:00 Uhr', { when: often, hour: s.hour });
  };
  return (
    <>
      {!data.length ? (
        <Empty tour="reports-schedules">{t('Noch keine Zeitpläne. Auf einem Dashboard „Per E-Mail“ wählen, um eine Zusammenfassung regelmäßig zu verschicken.')}</Empty>
      ) : (
        <div className="card" style={{ padding: 0 }} data-tour="reports-schedules">
          <table className="t">
            <thead>
              <tr>
                <th>{t('Dashboard / Bericht')}</th>
                <th>{t('Wann')}</th>
                <th>{t('Empfänger')}</th>
                <th>{t('Zuletzt')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((s: any) => (
                <tr key={s.id} className={s.active ? '' : 'muted'}>
                  <td>
                    {s.target_name} {!s.active && <Badge>{t('pausiert')}</Badge>}
                  </td>
                  <td>
                    {when(s)}
                    <div className="muted small">{t('nächster Versand:')} {s.active ? dt(s.next_at) : '–'}</div>
                  </td>
                  <td className="small">{s.recipients.join(', ')}</td>
                  <td className="small">
                    {s.last_sent_at ? dt(s.last_sent_at) : '–'}
                    {s.last_status && <div className="muted">{s.last_status}</div>}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn small secondary" onClick={async () => setPreview(await api.get(`/api/reports/schedules/${s.id}/preview`).catch((e) => (act(() => Promise.reject(e)), null)))}>
                      {t('Vorschau')}
                    </button>{' '}
                    <button className="btn small secondary" onClick={async () => (await act(() => api.post(`/api/reports/schedules/${s.id}/send`), t('Versendet'))) && reload()}>
                      {t('Jetzt senden')}
                    </button>{' '}
                    <button className="icon-btn" aria-label={t('Bearbeiten')} onClick={() => setEditing({ ...s, recipients: s.recipients.join(', ') })}>
                      <Icon name="edit" />
                    </button>
                    <button className="icon-btn" aria-label={s.active ? t('Pausieren') : t('Fortsetzen')} onClick={async () => (await act(() => api.patch(`/api/reports/schedules/${s.id}`, { active: !s.active }))) && reload()}>
                      <Icon name={s.active ? 'pause' : 'send'} />
                    </button>
                    <button className="icon-btn" aria-label={t('Löschen')} onClick={async () => confirmAsk(t('Zeitplan löschen?')) && (await act(() => api.del(`/api/reports/schedules/${s.id}`))) && reload()}>
                      <Icon name="trash" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <ScheduleForm
          title={t('Zeitplan: {name}', { name: editing.target_name })}
          s={editing}
          setS={setEditing}
          onClose={() => setEditing(null)}
          onSave={async () => {
            const { frequency, weekday, monthday, hour, recipients, range } = editing;
            if (await act(() => api.patch(`/api/reports/schedules/${editing.id}`, { frequency, weekday: Number(weekday), monthday: Number(monthday), hour: Number(hour), recipients, range }), t('Gespeichert'))) {
              setEditing(null);
              reload();
            }
          }}
        />
      )}
      {preview && (
        <Modal title={preview.subject} onClose={() => setPreview(null)} wide>
          <iframe className="rpt-mail-preview" title={t('E-Mail-Vorschau')} sandbox="" srcDoc={preview.html} />
        </Modal>
      )}
    </>
  );
}

// German labels (message ids of the reports catalog), shown through t()
const TABS: [string, string, string][] = [
  ['', 'Dashboards', 'grid'],
  ['new', 'Bericht erstellen', 'vizBar'],
  ['library', 'Bibliothek', 'library'],
  ['templates', 'Vorlagen', 'layers'],
  ['schedules', 'Zeitpläne', 'schedule'],
];

export function Reports({ path }: { path: string[] }) {
  const t = useT('reports');
  const { meta, error } = useReportMeta();
  const [section, id] = path;
  const tab = section === 'd' || !section ? '' : section === 'r' ? 'new' : section;
  useEffect(() => {
    window.scrollTo?.(0, 0);
  }, [section, id]);
  return (
    <div className="rpt">
      <PageHead title={t('Berichte')} sub={t('Eigene Auswertungen über alle Bereiche – als Dashboard, Bericht oder E-Mail.')}>
        <button className="btn" data-tour="reports-new" onClick={() => navigate('reports/new')}>
          {t('+ Bericht')}
        </button>
      </PageHead>
      <div className="tabs" data-tour="reports-tabs">
        {TABS.map(([k, label, icon]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => navigate(k ? `reports/${k}` : 'reports')}>
            <Icon name={icon as any} size={15} /> {t(label)}
          </button>
        ))}
      </div>
      {error ? (
        <p className="rpt-error">{error}</p>
      ) : !meta ? (
        <Spinner />
      ) : tab === 'new' ? (
        <ReportBuilder key={`${id ?? 'new'}${location.search}`} meta={meta} reportId={section === 'r' ? id : undefined} />
      ) : tab === 'library' ? (
        <Library meta={meta} />
      ) : tab === 'templates' ? (
        <Templates />
      ) : tab === 'schedules' ? (
        <Schedules />
      ) : (
        <Dashboards id={section === 'd' ? id : undefined} meta={meta} />
      )}
    </div>
  );
}
