import { useState } from 'react';
import { api, dt } from '../api';
import { useT } from '../i18n';
import { act, Badge, Check, Empty, Field, Input, Modal, pressable, Select, Spinner, Textarea, useLoad } from '../ui';

/**
 * Agentur → Cloud → Missbrauch: notices from /abuse (Digital Services Act Art. 16) with the decision that goes back to the person
 * who reported, the accounts with a measure in place, and the measures themselves – pause sending, take sites and forms offline,
 * suspend (the owner gets the reasons, Art. 17). Server side: modules/cloud-abuse.ts, docs/cloud.md#abuse-handling.
 */

interface Report {
  id: string;
  category: string;
  category_label: string;
  urls: string[];
  explanation: string;
  reporter_name: string;
  reporter_email: string;
  tenant_id: string | null;
  tenant_name: string | null;
  status: string;
  status_label: string;
  decision: string;
  decided_at: string | null;
  created_at: string;
}
interface Flagged {
  tenant_id: string;
  name: string;
  email: string;
  sending_paused_at: string | null;
  sending_reason: string;
  sending_auto: number;
  sites_offline_at: string | null;
  sites_reason: string;
  suspended_at: string | null;
  suspend_reason: string;
}

const STATUS_TONE: Record<string, 'blue' | 'yellow' | 'green' | 'gray'> = { new: 'blue', in_review: 'yellow', actioned: 'green', rejected: 'gray' };

function ActionModal({ tenantId, tenantName, onClose, onDone }: { tenantId?: string; tenantName?: string; onClose: () => void; onDone: () => void }) {
  const t = useT('ops');
  const tenants = useLoad(() => (tenantId ? Promise.resolve({ items: [] as { id: string; name: string }[] }) : api.get<{ items: { id: string; name: string }[] }>('/api/cloud/console/tenants?limit=500')), [tenantId]);
  const [f, setF] = useState({ tenant: tenantId ?? '', action: 'pause_sending', reason: '', notify: true });
  const actions: [string, string][] = [
    ['pause_sending', t('Versand pausieren')],
    ['unpublish_sites', t('Websites und Formulare offline nehmen')],
    ['suspend', t('Konto sperren')],
    ['resume_sending', t('Versand wieder freigeben')],
    ['publish_sites', t('Websites wieder online')],
    ['unsuspend', t('Sperre aufheben')],
  ];
  const save = async () => {
    const r = await act(() => api.post(`/api/cloud/console/tenants/${f.tenant}/abuse`, { action: f.action, reason: f.reason, notify: f.notify }), t('Maßnahme gespeichert'));
    if (r) onDone();
  };
  return (
    <Modal
      title={tenantName ? t('Maßnahme für {name}', { name: tenantName }) : t('Maßnahme ergreifen')}
      onClose={onClose}
      footer={
        <button className="btn" onClick={save} disabled={!f.tenant}>
          {t('Ausführen')}
        </button>
      }
    >
      {!tenantId && (
        <Field label={t('Kunde')}>
          {tenants.data ? <Select value={f.tenant} onChange={(v) => setF({ ...f, tenant: v })} placeholder={t('Kunde wählen …')} options={tenants.data.items.map((x) => [x.id, x.name])} /> : <Spinner />}
        </Field>
      )}
      <Field label={t('Maßnahme')}>
        <Select value={f.action} onChange={(v) => setF({ ...f, action: v })} options={actions} />
      </Field>
      <Field label={t('Begründung')} hint={t('Geht an den Inhaber des Kontos (Begründungspflicht, DSA Art. 17). Konkret: welcher Inhalt, welche Regel.')}>
        <Textarea value={f.reason} onChange={(v) => setF({ ...f, reason: v })} rows={4} maxLength={1000} />
      </Field>
      <Check checked={f.notify} onChange={(v) => setF({ ...f, notify: v })} label={t('Inhaber per E-Mail informieren')} />
    </Modal>
  );
}

function ReportModal({ report, onClose, onSaved, onAction }: { report: Report; onClose: () => void; onSaved: () => void; onAction: (id: string, name: string) => void }) {
  const t = useT('ops');
  const [f, setF] = useState({ status: report.status === 'new' ? 'in_review' : report.status, decision: report.decision, notify: true });
  const statuses: [string, string][] = [
    ['new', t('Neu')],
    ['in_review', t('In Prüfung')],
    ['actioned', t('Maßnahme ergriffen')],
    ['rejected', t('Abgelehnt')],
  ];
  const save = async () => {
    const r = await act(() => api.patch(`/api/cloud/console/abuse/${report.id}`, f), t('Meldung gespeichert'));
    if (r) onSaved();
  };
  return (
    <Modal
      title={t('Meldung {id}', { id: report.id })}
      onClose={onClose}
      wide
      footer={
        <button className="btn" onClick={save}>
          {t('Speichern')}
        </button>
      }
    >
      <p>
        <Badge tone="red">{report.category_label}</Badge> <span className="muted small">{dt(report.created_at)}</span>
      </p>
      <Field label={t('Adressen')}>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {report.urls.map((u) => (
            <li key={u}>
              <code>{u}</code>
            </li>
          ))}
        </ul>
      </Field>
      <Field label={t('Begründung des Meldenden')}>
        <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{report.explanation}</p>
      </Field>
      <p className="small">
        {t('Gemeldet von:')} {report.reporter_name || t('anonym')} {report.reporter_email && `<${report.reporter_email}>`}
      </p>
      <p className="small">
        {t('Kunde:')}{' '}
        {report.tenant_id ? (
          <>
            <strong>{report.tenant_name}</strong>{' '}
            <button className="btn small secondary" onClick={() => onAction(report.tenant_id!, report.tenant_name ?? '')}>
              {t('Maßnahme ergreifen')}
            </button>
          </>
        ) : (
          t('keinem Kunden zugeordnet')
        )}
      </p>
      <Field label={t('Status')}>
        <Select value={f.status} onChange={(v) => setF({ ...f, status: v })} options={statuses} />
      </Field>
      <Field label={t('Entscheidung und Begründung')} hint={t('Beim Abschließen (Maßnahme ergriffen / Abgelehnt) bekommt der Meldende sie per E-Mail (DSA Art. 16 Abs. 5).')}>
        <Textarea value={f.decision} onChange={(v) => setF({ ...f, decision: v })} rows={4} maxLength={4000} />
      </Field>
      <Check checked={f.notify} onChange={(v) => setF({ ...f, notify: v })} label={t('Meldenden informieren')} />
    </Modal>
  );
}

export function CloudAbuse() {
  const t = useT('ops');
  const o = useLoad(() => api.get('/api/cloud/console/abuse'), []);
  const [open, setOpen] = useState<Report | null>(null);
  const [action, setAction] = useState<{ id?: string; name?: string } | null>(null);
  const [settings, setSettings] = useState<{ abuse_email: string; auto_pause: boolean } | null>(null);
  if (!o.data) return o.error ? <Empty>{o.error}</Empty> : <Spinner />;
  const d = o.data;
  const s = settings ?? d.settings;
  const lift = (tid: string, act0: string) => act(() => api.post(`/api/cloud/console/tenants/${tid}/abuse`, { action: act0, reason: '' }), t('Aufgehoben')).then(() => o.reload());
  return (
    <div data-tour="cloud-abuse">
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>{t('Meldewege')}</h3>
        <p className="small">
          {t('Öffentliches Meldeformular (DSA Art. 16):')}{' '}
          <a href={d.public_url} target="_blank" rel="noopener">
            {d.public_url}
          </a>
        </p>
        <div className="grid2">
          <Field label={t('Abuse-Adresse')} hint={t('Steht auf dem Meldeformular, z. B. abuse@deine-domain.de')}>
            <Input value={s.abuse_email} onChange={(v) => setSettings({ ...s, abuse_email: v })} maxLength={200} />
          </Field>
          <div style={{ alignSelf: 'end' }}>
            <Check checked={s.auto_pause} onChange={(v) => setSettings({ ...s, auto_pause: v })} label={t('Versand automatisch pausieren (Beschwerden über 0,1 % oder Bounces über 5 % der letzten 500 E-Mails)')} />
          </div>
        </div>
        <button className="btn small" disabled={!settings} onClick={() => act(() => api.put('/api/cloud/console/abuse/settings', s), t('Gespeichert')).then(() => (setSettings(null), o.reload()))}>
          {t('Speichern')}
        </button>
      </div>

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3>{t('Konten mit Maßnahmen')}</h3>
        <button className="btn small" onClick={() => setAction({})}>
          {t('Maßnahme ergreifen')}
        </button>
      </div>
      {!d.flagged.length ? (
        <Empty>{t('Kein Konto ist pausiert, offline oder gesperrt.')}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="t">
            <tbody>
              {d.flagged.map((f: Flagged) => (
                <tr key={f.tenant_id}>
                  <td>
                    <strong>{f.name}</strong>
                    <div className="muted small">{f.email}</div>
                  </td>
                  <td className="small">
                    {f.suspended_at && (
                      <div>
                        <Badge tone="red">{t('Gesperrt')}</Badge> {f.suspend_reason}{' '}
                        <button className="btn small secondary" onClick={() => lift(f.tenant_id, 'unsuspend')}>
                          {t('Aufheben')}
                        </button>
                      </div>
                    )}
                    {f.sending_paused_at && (
                      <div>
                        <Badge tone="yellow">{f.sending_auto ? t('Versand automatisch pausiert') : t('Versand pausiert')}</Badge> {f.sending_reason}{' '}
                        <button className="btn small secondary" onClick={() => lift(f.tenant_id, 'resume_sending')}>
                          {t('Freigeben')}
                        </button>
                      </div>
                    )}
                    {f.sites_offline_at && (
                      <div>
                        <Badge tone="yellow">{t('Websites offline')}</Badge> {f.sites_reason}{' '}
                        <button className="btn small secondary" onClick={() => lift(f.tenant_id, 'publish_sites')}>
                          {t('Wieder online')}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>{t('Meldungen')}</h3>
      {!d.reports.length ? (
        <Empty>{t('Noch keine Meldungen.')}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>{t('Eingang')}</th>
                <th>{t('Art')}</th>
                <th>{t('Adresse')}</th>
                <th>{t('Kunde')}</th>
                <th>{t('Status')}</th>
              </tr>
            </thead>
            <tbody>
              {d.reports.map((r: Report) => (
                <tr key={r.id} className="click" {...pressable(() => setOpen(r))}>
                  <td>{dt(r.created_at)}</td>
                  <td>{r.category_label}</td>
                  <td className="small">
                    <code>{r.urls[0]}</code>
                    {r.urls.length > 1 ? ` +${r.urls.length - 1}` : ''}
                  </td>
                  <td>{r.tenant_name ?? '–'}</td>
                  <td>
                    <Badge tone={STATUS_TONE[r.status] ?? 'gray'}>{r.status_label}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <ReportModal
          report={open}
          onClose={() => setOpen(null)}
          onSaved={() => {
            setOpen(null);
            void o.reload();
          }}
          onAction={(id, name) => {
            setOpen(null);
            setAction({ id, name });
          }}
        />
      )}
      {action && (
        <ActionModal
          tenantId={action.id}
          tenantName={action.name}
          onClose={() => setAction(null)}
          onDone={() => {
            setAction(null);
            void o.reload();
          }}
        />
      )}
    </div>
  );
}
