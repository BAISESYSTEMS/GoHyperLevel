import { useState } from 'react';
import { api, dt } from '../api';
import { useT } from '../i18n';
import { Badge, act, confirmAsk, toast, useLoad } from '../ui';

/** Ads → Leads: Google Ads lead forms as a lead source (modules/ads-google-leads.ts, docs/ads-manager.md#google-lead-forms). */
export function GoogleLeadsCard() {
  const t = useT('gaps');
  const s = useLoad(() => api.get<any>('/api/ads/google-leads').catch(() => null), []);
  const [key, setKey] = useState('');
  if (!s.data) return null;
  const d = s.data;
  const copy = (v: string) => navigator.clipboard?.writeText(v).then(() => toast(t('Kopiert')));
  const enable = async () => {
    const r = await act(() => api.post('/api/ads/google-leads/enable'));
    if (r) {
      setKey(r.key);
      s.reload();
    }
  };
  return (
    <div className="card" data-tour="google-leads">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>
          {t('Leads aus Google-Lead-Formularen')} {d.enabled && <Badge tone="green">{t('verbunden')}</Badge>}
        </h2>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn small" onClick={async () => (!d.enabled || confirmAsk(t('Neuen Schlüssel erzeugen? Der alte gilt dann nicht mehr.'))) && enable()}>
            {d.enabled ? t('Neuer Schlüssel') : t('Verbinden')}
          </button>
          {d.enabled && (
            <button className="btn small secondary" onClick={async () => (await act(() => api.post('/api/ads/google-leads/disable'))) && s.reload()}>
              {t('Trennen')}
            </button>
          )}
        </div>
      </div>
      <p className="muted small">{t('In Google Ads beim Lead-Formular unter „Webhook-Integration“ URL und Schlüssel eintragen – jeder Lead wird zum Kontakt und startet „Neuer Lead aus Anzeige“.')}</p>
      {d.enabled && (
        <p className="small">
          {t('Webhook-URL:')} <code style={{ overflowWrap: 'anywhere' }}>{d.url}</code>{' '}
          <button className="btn small secondary" onClick={() => copy(d.url)}>
            {t('Kopieren')}
          </button>
        </p>
      )}
      {key && (
        <p className="small">
          {t('Schlüssel (nur jetzt sichtbar):')} <code>{key}</code>{' '}
          <button className="btn small secondary" onClick={() => copy(key)}>
            {t('Kopieren')}
          </button>
        </p>
      )}
      {d.recent.length > 0 && (
        <table className="t">
          <tbody>
            {d.recent.map((l: any) => (
              <tr key={l.lead_id}>
                <td>
                  {[l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || l.lead_id} {l.is_test ? <Badge>{t('Test')}</Badge> : null}
                </td>
                <td className="muted small">{dt(l.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
