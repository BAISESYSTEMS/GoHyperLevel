import { useEffect, useState } from 'react';
import { api, dt } from '../api';
import { Empty, Field, Input, Select, Spinner, act, confirmAsk, useLoad } from '../ui';
import { HygieneBox, AddressCheck, SettingsBox } from './DeliverabilityTools';
import { Kpi, LevelBadge, RateBar, de, pct } from './MarketingKit';
import { useT } from '../i18n';
import { SortableGrid } from '../sortable/Sortable';

/**
 * Zustellbarkeit: where the sender stands (bounce, complaint and unsubscribe rates against their thresholds), the warm-up plan with its
 * daily caps for new senders, list hygiene and the address checks. Docs: docs/email-marketing.md.
 */

interface Thr {
  warn: number;
  critical: number;
  label: string;
}

const tone = (rate: number, t: Thr, few: boolean) => (few ? '' : rate >= t.critical ? 'critical' : rate >= t.warn ? 'warn' : '');

function Overview({ rep }: { rep: any }) {
  const t = useT('campaigns');
  const tot = rep.totals;
  const th: Record<string, Thr> = rep.thresholds;
  return (
    <div className="card mk-card" data-tour="mk-reputation">
      <div className="mk-actions" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{t('Reputation')}</h2>
        <LevelBadge level={tot.level} />
      </div>
      <p className="muted small mk-lead">
        {rep.sending_domain
          ? t('Gemessen an den Kampagnen-Mails der letzten {days} Tage ({sent} versendet, Absender-Domain {domain}).', { days: rep.days, sent: de(tot.sent), domain: rep.sending_domain })
          : t('Gemessen an den Kampagnen-Mails der letzten {days} Tage ({sent} versendet).', { days: rep.days, sent: de(tot.sent) })}
      </p>
      {tot.sent === 0 ? (
        <p className="mk-note">{t('Noch keine Kampagnen-Mails in diesem Zeitraum. Sobald die ersten Mails raus sind, siehst du hier, wie gut sie ankommen.')}</p>
      ) : (
        <>
          <SortableGrid id="deliverability.kpis" className="mk-kpis">
            <Kpi label={t('Versendet')} value={de(tot.sent)} />
            <RateBar label={t('Bounces')} rate={tot.rates.bounce} warn={th.bounce.warn} critical={th.bounce.critical} />
            <RateBar label={t('Spam-Beschwerden')} rate={tot.rates.complaint} warn={th.complaint.warn} critical={th.complaint.critical} />
            <RateBar label={t('Abmeldungen')} rate={tot.rates.unsubscribe} warn={th.unsubscribe.warn} critical={th.unsubscribe.critical} />
            <Kpi label={t('Öffnungen (Personen)')} value={pct(tot.rates.open, 1)} sub={t('Klicks {pct}', { pct: pct(tot.rates.click, 1) })} />
          </SortableGrid>
          {tot.level === 'few' && <p className="mk-note">{t('Bisher unter 100 versendete Mails – für eine verlässliche Bewertung ist das zu wenig. Die Raten sind Richtwerte.')}</p>}
        </>
      )}
      {rep.warnings.map((w: any, i: number) => (
        <div key={i} className={`mk-note ${w.level === 'critical' ? 'bad' : 'warn'}`} role={w.level === 'critical' ? 'alert' : 'note'}>
          <strong>{w.text}</strong>
          <div className="small">{w.tip}</div>
        </div>
      ))}
      {tot.level === 'ok' && rep.warnings.length === 0 && <p className="mk-note ok">{t('Alle Werte liegen unter den Schwellen. Weiter so.')}</p>}
      <p className="muted small" style={{ marginBottom: 0 }}>
        {t('Schwellen: Bounces ab {bw} Warnung, ab {bc} kritisch · Beschwerden ab {cw} / {cc} · Abmeldungen ab {uw} / {uc}. Große Anbieter wie Gmail und Yahoo erwarten Beschwerden unter 0,3 %.', {
          bw: pct(th.bounce.warn, 1),
          bc: pct(th.bounce.critical, 1),
          cw: pct(th.complaint.warn, 1),
          cc: pct(th.complaint.critical, 1),
          uw: pct(th.unsubscribe.warn, 1),
          uc: pct(th.unsubscribe.critical, 1),
        })}
      </p>
    </div>
  );
}

type Row = { key: string; label: string; sent: number; bounced: number; complained: number; unsubscribed: number; level: string; rates: Record<string, number>; sent_at?: string | null; from?: string };

function Tables({ rep }: { rep: any }) {
  const t = useT('campaigns');
  const [by, setBy] = useState<'campaign' | 'domain' | 'week'>('campaign');
  const th: Record<string, Thr> = rep.thresholds;
  const rows: Row[] = by === 'campaign' ? rep.by_campaign : by === 'domain' ? rep.by_domain : rep.by_week;
  const first = by === 'campaign' ? t('Kampagne') : by === 'domain' ? t('Empfänger-Domain') : t('Woche');
  const cell = (r: Row, m: 'bounce' | 'complaint' | 'unsubscribe', count: number) => (
    <td className={`mk-r ${tone(r.rates[m], th[m], r.sent < 100)}`}>
      {pct(r.rates[m])} <span className="muted small">({de(count)})</span>
    </td>
  );
  return (
    <div className="card mk-card" data-tour="mk-reputation-tables">
      <h2>{t('Aufschlüsselung')}</h2>
      <div className="mk-sub" role="group" aria-label={t('Aufschlüsselung wählen')}>
        {([['campaign', t('Je Kampagne')], ['domain', t('Je Empfänger-Domain')], ['week', t('Je Woche')]] as const).map(([k, l]) => (
          <button key={k} type="button" className={by === k ? 'on' : ''} onClick={() => setBy(k)}>
            {l}
          </button>
        ))}
      </div>
      {rows.length ? (
        <div className="mk-table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>{first}</th>
                <th>{t('Versendet')}</th>
                <th>{t('Bounces')}</th>
                <th>{t('Beschwerden')}</th>
                <th>{t('Abmeldungen')}</th>
                <th>{t('Öffnungen')}</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>{by === 'week' ? t('Woche ab {date}', { date: r.from ?? '' }) : r.label}</td>
                  <td>{de(r.sent)}</td>
                  {cell(r, 'bounce', r.bounced)}
                  {cell(r, 'complaint', r.complained)}
                  {cell(r, 'unsubscribe', r.unsubscribed)}
                  <td>{pct(r.rates.open, 1)}</td>
                  <td>
                    <LevelBadge level={r.level} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>{t('Keine Daten im gewählten Zeitraum.')}</Empty>
      )}
      <p className="muted small" style={{ marginBottom: 0 }}>
        {t('Abmeldungen werden der letzten Kampagnen-Mail zugerechnet, die der Kontakt in den 7 Tagen davor bekommen hat. Öffnungen zählen nur Personen, keine Mail-Programme im Hintergrund.')}
      </p>
    </div>
  );
}

function Warmup({ rep }: { rep: any }) {
  const t = useT('campaigns');
  const w = useLoad(() => api.get('/api/deliverability/warmup'), []);
  const [plan, setPlan] = useState('standard');
  const [domain, setDomain] = useState('');
  useEffect(() => {
    if (w.data?.configured) setDomain(w.data.domain ?? '');
    else if (!domain && rep?.sending_domain) setDomain(rep.sending_domain);
  }, [w.data?.configured, rep?.sending_domain]);
  if (!w.data) return <div className="card mk-card">{w.error ? <p className="muted">{w.error}</p> : <Spinner />}</div>;
  const d = w.data;
  const s = d.state;
  const plans: any[] = d.plans;
  const start = async (p: string) => {
    if (await act(() => api.post('/api/deliverability/warmup', { plan: p, domain }), t('Aufwärmplan gestartet'))) w.reload();
  };
  const put = async (body: any, ok: string) => {
    if (await act(() => api.put('/api/deliverability/warmup', body), ok)) w.reload();
  };
  return (
    <div className="card mk-card" data-tour="mk-warmup">
      <h2>{t('Aufwärmplan')}</h2>
      <p className="muted small mk-lead">{t('Eine neue Absender-Domain hat bei Gmail, GMX und Co. noch keinen Ruf. Wer sofort an alle schickt, landet im Spam. Der Plan begrenzt die Kampagnen-Mails pro Tag und steigert das Limit täglich; was nicht mehr passt, geht am nächsten Tag raus.')}</p>
      {!d.configured ? (
        <>
          <div className="mk-pick" role="radiogroup" aria-label={t('Plan wählen')}>
            {plans.map((p) => (
              <label key={p.key} className={plan === p.key ? 'on' : ''}>
                <input type="radio" name="mk-plan" checked={plan === p.key} onChange={() => setPlan(p.key)} />
                <span>
                  <strong>{p.label}</strong>
                  <div className="muted small">{p.text}</div>
                  <div className="mk-caps" aria-label={t('Tageslimits der ersten Tage')}>
                    {p.schedule.slice(0, 10).map((x: any) => (
                      <span key={x.day}>{t('Tag {day}: {cap}', { day: x.day, cap: de(x.cap) })}</span>
                    ))}
                    <span>…</span>
                  </div>
                </span>
              </label>
            ))}
          </div>
          <Field label={t('Absender-Domain (nur zur Erinnerung, optional)')}>
            <Input value={domain} onChange={setDomain} placeholder={t('firma.de')} />
          </Field>
          <button className="btn" onClick={() => start(plan)} data-tour="mk-warmup-start">
            {t('Aufwärmplan starten')}
          </button>
        </>
      ) : s ? (
        <>
          {s.done ? (
            <p className="mk-note ok">{t('Aufgewärmt: Der Plan ist durchlaufen, es gibt kein Tageslimit mehr. Du kannst ihn entfernen.')}</p>
          ) : s.paused ? (
            <p className="mk-note warn">{t('Pausiert – im Moment gilt kein Tageslimit. Mit „Fortsetzen“ greift der Plan wieder.')}</p>
          ) : (
            <>
              <SortableGrid id="deliverability.domain-kpis" className="mk-kpis">
                <Kpi label={t('Tag {day} von {total}', { day: s.day, total: s.total_days })} value={t('{n} Mails', { n: de(s.cap) })} sub={t('Limit für heute')} />
                <Kpi label={t('Heute gesendet')} value={de(s.sent_today)} />
                <Kpi label={t('Heute noch möglich')} value={de(s.remaining)} />
              </SortableGrid>
              <div className="mk-progress" role="progressbar" aria-valuemin={0} aria-valuemax={s.cap ?? 0} aria-valuenow={s.sent_today}>
                <div style={{ width: `${s.cap ? Math.min(100, (s.sent_today / s.cap) * 100) : 0}%` }} />
              </div>
              {s.reduced && <p className="mk-note bad">{t('Das Tageslimit ist halbiert, weil die Werte der letzten Tage kritisch sind (siehe Reputation oben). Erst Ursache beheben, dann steigt es wieder.')}</p>}
            </>
          )}
          {s.upcoming.length > 0 && (
            <div className="mk-caps" aria-label={t('Kommende Tage')}>
              {s.upcoming.map((u: any) => (
                <span key={u.day}>{t('Tag {day}: {cap}', { day: u.day, cap: u.cap === null ? t('unbegrenzt') : de(u.cap) })}</span>
              ))}
            </div>
          )}
          <div className="mk-actions" style={{ marginTop: 12 }}>
            {!s.done && (
              <button className="btn secondary" onClick={() => put({ paused: !s.paused }, s.paused ? t('Plan läuft wieder') : t('Plan pausiert'))}>
                {s.paused ? t('Fortsetzen') : t('Pausieren')}
              </button>
            )}
            <Select value={d.plan} onChange={(p) => put({ plan: p }, t('Plan gewechselt'))} options={plans.map((p) => [p.key, p.label] as [string, string])} />
            <button className="btn secondary" onClick={() => confirmAsk(t('Den Plan mit Tag 1 neu beginnen?')) && start(d.plan)}>
              {t('Neu beginnen')}
            </button>
            <button className="btn ghost" onClick={async () => confirmAsk(t('Aufwärmplan beenden? Danach gilt kein Tageslimit mehr.')) && (await act(() => api.del('/api/deliverability/warmup'), t('Plan beendet'))) && w.reload()}>
              {t('Plan beenden')}
            </button>
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>
            {d.domain ? t('Gestartet am {date} für {domain}.', { date: dt(d.started_at), domain: d.domain }) : t('Gestartet am {date}.', { date: dt(d.started_at) })}{' '}
            {t('Beim Versand kommen zuerst Kontakte dran, die zuletzt Mails geöffnet haben – sie sind der beste Start für einen guten Ruf.')}
          </p>
        </>
      ) : null}
    </div>
  );
}

export function Deliverability() {
  const t = useT('campaigns');
  const [days, setDays] = useState('90');
  const rep = useLoad(() => api.get(`/api/deliverability/reputation?days=${days}`), [days]);
  return (
    <div data-tour="deliverability-page">
      <div className="mk-actions" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <p className="muted mk-lead" style={{ margin: 0, flex: '1 1 320px' }}>
          {t('Damit Mails im Posteingang landen: Reputation im Blick behalten, neue Absender aufwärmen, die Liste sauber halten und Adressen vor dem Versand prüfen.')}
        </p>
        <Select value={days} onChange={setDays} options={[['30', t('Letzte 30 Tage')], ['90', t('Letzte 90 Tage')], ['180', t('Letzte 180 Tage')], ['365', t('Letztes Jahr')]]} />
      </div>
      {rep.data ? <Overview rep={rep.data} /> : <div className="card mk-card">{rep.error ? <p className="muted">{rep.error}</p> : <Spinner />}</div>}
      <Warmup rep={rep.data} />
      {rep.data && <Tables rep={rep.data} />}
      <HygieneBox />
      <AddressCheck />
      <SettingsBox />
    </div>
  );
}

