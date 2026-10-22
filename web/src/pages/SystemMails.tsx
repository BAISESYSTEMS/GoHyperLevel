import { useState } from 'react';
import { api, dt } from '../api';
import { useT } from '../i18n';
import { Badge, Field, Input, Modal, Textarea, act, confirmAsk, useLoad } from '../ui';

/** Agentur → Branding: own wording for the system mails (modules/system-mails.ts, docs/saas.md#system-mails; slot "agency.branding"). */
export function SystemMailsCard() {
  const t = useT('gaps');
  const list = useLoad(() => api.get<any[]>('/api/agency/system-mails'), []);
  const [edit, setEdit] = useState<any>(null);
  if (!list.data) return null;
  const save = async () => {
    if (!edit) return;
    if (await act(() => api.put(`/api/agency/system-mails/${edit.key}`, { subject: edit.subject, body: edit.body }), t('Gespeichert'))) {
      setEdit(null);
      list.reload();
    }
  };
  return (
    <div className="card" data-tour="system-mails">
      <h2 style={{ marginTop: 0 }}>{t('Texte der System-Mails')}</h2>
      <p className="muted small">{t('Einladung, Anmelde-Link und Willkommens-Mail in deinen eigenen Worten. Ohne eigene Fassung gilt der Standardtext.')}</p>
      <table className="t">
        <tbody>
          {list.data.map((m) => (
            <tr key={m.key}>
              <td>
                {t(m.label)} {m.custom ? <Badge tone="blue">{t('eigener Text')}</Badge> : <Badge>{t('Standard')}</Badge>}
                {m.updated_at && <div className="muted small">{dt(m.updated_at)}</div>}
              </td>
              <td style={{ textAlign: 'right' }}>
                <div className="actions" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn small secondary" onClick={() => setEdit({ ...m, subject: m.subject || m.default_subject, body: m.body || m.default_body })}>
                    {t('Anpassen')}
                  </button>
                  {m.custom && (
                    <button className="btn small secondary" onClick={async () => confirmAsk(t('Wieder den Standardtext verwenden?')) && (await act(() => api.del(`/api/agency/system-mails/${m.key}`))) && list.reload()}>
                      {t('Standard')}
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && (
        <Modal
          title={t(edit.label)}
          onClose={() => setEdit(null)}
          wide
          footer={
            <button className="btn" disabled={!edit.subject.trim() || !edit.body.includes('{{link}}')} onClick={save}>
              {t('Speichern')}
            </button>
          }
        >
          <Field label={t('Betreff')}>
            <Input value={edit.subject} onChange={(v) => setEdit({ ...edit, subject: v })} />
          </Field>
          <Field label={t('Text')} hint={t('Platzhalter: {list} – {{link}} muss im Text stehen.', { list: edit.vars.map((v: string) => `{{${v}}}`).join(', ') })}>
            <Textarea rows={10} value={edit.body} onChange={(v) => setEdit({ ...edit, body: v })} />
          </Field>
        </Modal>
      )}
    </div>
  );
}
