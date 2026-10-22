import { useState } from 'react';
import { Icon } from '../icons';
import { api, dt } from '../api';
import { useT } from '../i18n';
import { Badge, Field, Input, Modal, Select, act, confirmAsk, useLoad } from '../ui';

/**
 * Einstellungen → Telefonie: your own existing number as caller ID (modules/caller-ids.ts – Twilio Verified Caller IDs). Adding a
 * number starts Twilio's verification call; the code shown here is typed in on that call. The default caller ID applies to the
 * browser phone, the power dialer, click-to-call and outbound AI calls. Slot "telephony.settings".
 */

export function CallerIdsCard() {
  const t = useT('callerids');
  const data = useLoad(() => api.get<any>('/api/caller-ids').catch(() => null), []);
  const [add, setAdd] = useState<null | { number: string; name: string; code?: string; id?: string }>(null);
  if (!data.data) return null;
  const d = data.data;
  const verified: string[] = d.caller_ids.filter((c: any) => c.status === 'verified').map((c: any) => c.number);
  const start = async () => {
    if (!add) return;
    const r = await act(() => api.post('/api/caller-ids', { number: add.number, name: add.name }));
    if (!r) return;
    data.reload();
    setAdd({ ...add, code: r.validation_code, id: r.id });
  };
  const check = async (id: string) => {
    const r = await act(() => api.post(`/api/caller-ids/${id}/check`));
    if (r) data.reload();
    return r;
  };
  return (
    <div className="card" data-tour="caller-ids">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>
          <Icon name="callOut" size={18} /> {t('Eigene Nummer als Absender')}
        </h2>
        <button className="btn small" disabled={!d.telephony_ready} onClick={() => setAdd({ number: '', name: '' })}>
          + {t('Nummer bestätigen')}
        </button>
      </div>
      <p className="muted small">{t('Ruf mit deiner bestehenden Festnetz- oder Handynummer an, statt mit der Twilio-Nummer: Twilio ruft die Nummer einmal an, du tippst den angezeigten Code ein. Gilt für Browser-Telefon, Power-Dialer, Klick-Anruf und KI-Anrufe. Eingehende Anrufe auf diese Nummer laufen weiter wie bisher.')}</p>
      <Field label={t('Standard-Absender')}>
        <Select
          value={d.default_set}
          onChange={async (v) => (await act(() => api.put('/api/caller-ids/default', { number: v }), t('Gespeichert'))) && data.reload()}
          options={[['', t('Erste Twilio-Nummer ({n})', { n: d.twilio_numbers[0] ?? '–' })], ...[...d.twilio_numbers, ...verified].map((n: string) => [n, n] as [string, string])]}
        />
      </Field>
      {d.caller_ids.length > 0 && (
        <table className="t">
          <thead>
            <tr>
              <th>{t('Nummer')}</th>
              <th>{t('Status')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d.caller_ids.map((c: any) => (
              <tr key={c.id}>
                <td>
                  {c.number} {c.name && c.name !== c.number && <span className="muted small">{c.name}</span>}
                </td>
                <td>
                  {c.status === 'verified' ? <Badge tone="green">{t('bestätigt')}</Badge> : c.status === 'pending' ? <Badge tone="yellow">{t('wartet auf Code {code}', { code: c.validation_code })}</Badge> : <Badge tone="red">{t('fehlgeschlagen')}</Badge>}
                  {c.verified_at && <div className="muted small">{dt(c.verified_at)}</div>}
                  {c.error && <div className="muted small">{c.error}</div>}
                </td>
                <td>
                  <div className="actions" style={{ justifyContent: 'flex-end' }}>
                    {c.status !== 'verified' && (
                      <button className="btn small secondary" onClick={() => check(c.id)}>
                        {t('Prüfen')}
                      </button>
                    )}
                    <button className="btn small secondary" aria-label={t('{n} entfernen', { n: c.number })} onClick={async () => confirmAsk(t('{n} als Absender entfernen?', { n: c.number })) && (await act(() => api.del(`/api/caller-ids/${c.id}`))) && data.reload()}>
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {add && (
        <Modal
          title={t('Eigene Nummer bestätigen')}
          onClose={() => setAdd(null)}
          footer={
            add.code ? (
              <button className="btn" onClick={async () => (await check(add.id!))?.status === 'verified' && setAdd(null)}>
                {t('Ich habe den Code eingegeben')}
              </button>
            ) : (
              <button className="btn" disabled={!add.number.trim()} onClick={start}>
                <Icon name="phone" size={14} /> {t('Bestätigungsanruf starten')}
              </button>
            )
          }
        >
          {add.code ? (
            <>
              <p>{t('Twilio ruft jetzt {n} an. Nimm ab und tippe diesen Code ein:', { n: add.number })}</p>
              <p className="caller-code" style={{ fontSize: 32, fontWeight: 700, letterSpacing: 6, textAlign: 'center' }} aria-live="polite">
                {add.code}
              </p>
              <p className="muted small">{t('Danach ist die Nummer als Absender wählbar. Kam kein Anruf, schließe das Fenster und starte es neu.')}</p>
            </>
          ) : (
            <>
              <Field label={t('Nummer')} hint={t('Im Format +49…; die Nummer muss gerade erreichbar sein.')}>
                <Input value={add.number} onChange={(v) => setAdd({ ...add, number: v })} placeholder="+4930…" inputMode="tel" autoFocus />
              </Field>
              <Field label={t('Bezeichnung (optional)')}>
                <Input value={add.name} onChange={(v) => setAdd({ ...add, name: v })} placeholder={t('z. B. Büro')} />
              </Field>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
