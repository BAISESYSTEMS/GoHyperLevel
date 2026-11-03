import { useState } from 'react';
import { api, d, dt } from '../api';
import { useT } from '../i18n';
import { act, Badge, Input, Select, useLoad } from '../ui';

/** "Wiedervorlage am" (server/modules/contact-followup.ts): the contact list's filter and the card on the contact page. */

export type FollowUpView = 'hide' | 'all' | 'waiting' | 'due';

/** Query string part for /api/contacts: a search finds waiting contacts too. */
export const followUpQs = (v: FollowUpView, searching: boolean) => (v === 'all' || (v === 'hide' && searching) ? '' : `&follow_up=${v}`);

export function FollowUpFilter({ value, onChange }: { value: FollowUpView; onChange: (v: FollowUpView) => void }) {
  const t = useT('contacts');
  return (
    <div style={{ width: 220 }}>
      <Select
        value={value}
        onChange={(v) => onChange((v || 'hide') as FollowUpView)}
        aria={t('Wiedervorlage')}
        options={[
          ['hide', t('Zurückgestellte ausblenden')],
          ['all', t('Auch zurückgestellte zeigen')],
          ['waiting', t('Nur zurückgestellte')],
          ['due', t('Wiedervorlage fällig')],
        ]}
      />
    </div>
  );
}

const inDays = (n: number) => {
  const x = new Date();
  x.setDate(x.getDate() + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

export function ContactFollowUp({ contactId }: { contactId: string }) {
  const t = useT('contacts');
  const { data, reload } = useLoad(() => api.get<any>(`/api/contacts/${contactId}/follow-up`).catch(() => null), [contactId]);
  const [day, setDay] = useState(inDays(7));
  const [note, setNote] = useState('');
  if (!data) return null;
  const set = async (at: string) => {
    if (await act(() => api.put(`/api/contacts/${contactId}/follow-up`, { at, note }), t('Wiedervorlage gesetzt'))) (setNote(''), reload());
  };
  return (
    <div className="card">
      <h2>{t('Wiedervorlage')}</h2>
      {data.due_at ? (
        <>
          <div>
            <strong>{d(data.due_at)}</strong> {data.due ? <Badge tone="yellow">{t('fällig')}</Badge> : <Badge tone="blue">{t('zurückgestellt')}</Badge>}
          </div>
          {data.note && <div style={{ marginTop: 4 }}>{data.note}</div>}
          <div className="muted small">{t('von {name}, {date}', { name: data.set_by ?? t('API'), date: dt(data.created_at) })}</div>
          <button className="btn small ghost" style={{ marginTop: 8 }} onClick={() => act(() => api.del(`/api/contacts/${contactId}/follow-up`), t('Wiedervorlage erledigt')).then(reload)}>
            {t('Erledigt')}
          </button>
        </>
      ) : (
        <>
          <p className="muted small">{t('Kontakt bis zu einem Datum zurückstellen – er verschwindet aus der Liste und taucht dann von selbst wieder auf (oder sobald er antwortet).')}</p>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <input type="date" value={day} min={inDays(1)} onChange={(e) => setDay(e.target.value)} aria-label={t('Wiedervorlage am')} />
            <button className="btn small" disabled={!day} onClick={() => set(day)}>
              {t('Zurückstellen')}
            </button>
          </div>
          <div className="row" style={{ marginTop: 6, gap: 6, flexWrap: 'wrap' }}>
            {[
              [3, t('3 Tage')],
              [7, t('1 Woche')],
              [30, t('1 Monat')],
            ].map(([n, label]) => (
              <button key={n} className="btn small ghost" onClick={() => setDay(inDays(n as number))}>
                {label}
              </button>
            ))}
          </div>
          <div style={{ marginTop: 6 }}>
            <Input value={note} onChange={setNote} placeholder={t('Warum? (optional)')} aria-label={t('Notiz zur Wiedervorlage')} />
          </div>
        </>
      )}
    </div>
  );
}
