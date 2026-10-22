import { useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { MoreFields } from '../areas/fields';
import { Field, Input, Select, act, useLoad } from '../ui';

/** Bewertungen → Anfragen an viele Kontakte und Erinnerung (modules/review-requests-plus.ts; slot "reviews.panel"). */
export function ReviewBulkCard() {
  const t = useT('gaps');
  const settings = useLoad(() => api.get<any>('/api/reviews/request-settings').catch(() => null), []);
  const [tag, setTag] = useState('');
  const [channel, setChannel] = useState('email');
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{ followup_days?: string; skip_days?: string }>({});
  if (!settings.data) return null;
  const s = settings.data;
  const send = async () => {
    setBusy(true);
    const r = await act(() => api.post('/api/reviews/request/bulk', { tag, channel }));
    setBusy(false);
    if (r) setResult(r);
  };
  const save = async (patch: any) => (await act(() => api.put('/api/reviews/request-settings', { ...s, ...patch }), t('Gespeichert'))) && settings.reload();
  return (
    <div className="card" data-tour="review-bulk">
      <h2 style={{ marginTop: 0 }}>{t('Viele Kunden auf einmal fragen')}</h2>
      <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label={t('Alle Kontakte mit Tag')}>
          <Input value={tag} onChange={setTag} placeholder={t('z. B. auftrag-erledigt')} />
        </Field>
        <Field label={t('Kanal')}>
          <Select value={channel} onChange={setChannel} options={[['email', t('E-Mail')], ['sms', 'SMS']]} />
        </Field>
        <button className="btn small" disabled={!tag.trim() || busy} onClick={send}>
          {busy ? t('Sende …') : t('Anfragen senden')}
        </button>
      </div>
      {result && (
        <p className="small">
          {t('{n} gesendet, {m} übersprungen.', { n: result.sent, m: result.skipped.length })}
          {result.skipped.length > 0 && <span className="muted"> {[...new Set(result.skipped.map((x: any) => x.reason))].join(' · ')}</span>}
        </p>
      )}
      <MoreFields id="review-bulk-settings" values={[s.followup_days || '', s.skip_days !== 90 ? s.skip_days : '']} label={t('Erinnerung & Abstand')}>
        <div className="grid2">
          <Field label={t('Erinnerung nach Tagen (0 = aus)')}>
            <Input type="number" min={0} max={30} value={edit.followup_days ?? s.followup_days} onChange={(v) => setEdit({ ...edit, followup_days: v })} onBlur={() => edit.followup_days !== undefined && save({ followup_days: Number(edit.followup_days) }).then(() => setEdit({}))} />
          </Field>
          <Field label={t('Niemanden öfter fragen als alle … Tage')}>
            <Input type="number" min={0} max={365} value={edit.skip_days ?? s.skip_days} onChange={(v) => setEdit({ ...edit, skip_days: v })} onBlur={() => edit.skip_days !== undefined && save({ skip_days: Number(edit.skip_days) }).then(() => setEdit({}))} />
          </Field>
        </div>
      </MoreFields>
    </div>
  );
}
