import { useState } from 'react';
import { api } from '../api';
import { ColumnChart } from '../charts/BarChart';
import { LineChart } from '../charts/LineChart';
import { color, type Shaped } from '../charts/core';
import { Empty, Select, Spinner, useLoad } from '../ui';
import { Kpi, Sec, euro } from './CommunityParts';
import { SortableGrid } from '../sortable/Sortable';

/**
 * Community → Zahlen: members over time, MRR and churn, trial conversion, active members per day, posts and comments per day,
 * top contributors and engagement. The numbers come from /api/community/groups/:id/analytics (services/community-growth.ts).
 */

const dayLabel = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;
const cats = (rows: { day: string }[]) => rows.map((r) => ({ k: r.day, l: dayLabel(r.day) }));
const shaped = (rows: { day: string }[], series: { key: string; label: string; values: number[] }[]): Shaped => ({
  categories: cats(rows),
  series: series.map((s, i) => ({ ...s, color: color(i) })),
  format: 'number',
  measures: [0],
  integer: true,
});
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${String(v).replace('.', ',')} %`);

export function StatsTab({ group }: { group: any }) {
  const [days, setDays] = useState('30');
  const r = useLoad(() => api.get<any>(`/api/community/groups/${group.id}/analytics?days=${days}`), [group.id, days]);
  const a = r.data;
  return (
    <div className="cma">
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <p className="muted" style={{ margin: 0 }}>
          Zeitraum: {a ? `${dayLabel(a.range.from)} – ${dayLabel(a.range.to)}` : '…'}
        </p>
        <div style={{ width: 200 }}>
          <Select value={days} onChange={setDays} options={[['7', 'Letzte 7 Tage'], ['30', 'Letzte 30 Tage'], ['90', 'Letzte 90 Tage'], ['365', 'Letztes Jahr']]} />
        </div>
      </div>
      {r.error ? (
        <Empty>{r.error}</Empty>
      ) : !a ? (
        <Spinner />
      ) : (
        <>
          <SortableGrid id="community-stats" className="cma-kpis" data-tour="community-stats">
            <Kpi label="Mitglieder" value={a.totals.members} note={`${a.totals.new_in_range} neu · ${a.totals.left_in_range} gegangen`} />
            <Kpi label="Aktiv heute" value={a.totals.dau_today} note={`Ø ${String(a.totals.dau_avg).replace('.', ',')} pro Tag`} />
            <Kpi label="Engagement" value={pct(a.totals.engagement_rate)} note={`${a.totals.mau} von ${a.totals.members} in 30 Tagen aktiv`} />
            <Kpi label="MRR (netto)" value={euro(a.revenue.mrr_cents, a.revenue.currency)} note={`${euro(a.revenue.arr_cents, a.revenue.currency)} im Jahr`} />
            <Kpi label="Zahlende" value={a.revenue.paying} note={`${a.revenue.trialing} in der Testphase${a.revenue.past_due ? ` · ${a.revenue.past_due} Zahlung offen` : ''}`} />
            <Kpi label="Abwanderung" value={pct(a.churn.paying_rate)} note={`Zahlende · alle Mitglieder ${pct(a.churn.members_rate)}`} tone={a.churn.paying_rate > 10 ? 'red' : undefined} />
            <Kpi label="Testphase → Abo" value={pct(a.trials.conversion_rate)} note={`${a.trials.started} gestartet · ${a.trials.converted} umgewandelt · ${a.trials.lost} verloren`} />
            <Kpi label="Beiträge pro Tag" value={String(a.totals.posts_per_day).replace('.', ',')} note={`${a.totals.comments_per_day.toString().replace('.', ',')} Kommentare pro Tag`} />
          </SortableGrid>
          {a.requests.pending > 0 && (
            <div className="cma-note">
              <strong>{a.requests.pending} Beitrittsanfragen warten auf dich.</strong> Du findest sie unter „Beitritt → Anfragen“.
            </div>
          )}
          <SortableGrid id="community.stats" className="cma-grid">
            <Sec title="Mitglieder" lead="Alle, die zum Ende des Tages dabei waren.">
              <LineChart area height={240} data={shaped(a.members, [{ key: 'total', label: 'Mitglieder', values: a.members.map((x: any) => x.total) }])} />
            </Sec>
            <Sec title="Neu und gegangen" lead="Wer pro Tag dazukam und wer ging (Kündigung, Zahlung fehlgeschlagen, Entfernung).">
              <ColumnChart stacked height={240} data={shaped(a.members, [{ key: 'joined', label: 'Neu', values: a.members.map((x: any) => x.joined) }, { key: 'left', label: 'Gegangen', values: a.members.map((x: any) => x.left) }])} />
            </Sec>
            <Sec title="Aktive Mitglieder pro Tag" lead="Wer an dem Tag die Community geöffnet hat.">
              <LineChart height={240} data={shaped(a.dau, [{ key: 'dau', label: 'Aktiv', values: a.dau.map((x: any) => x.n) }])} />
            </Sec>
            <Sec title="Beiträge und Kommentare pro Tag">
              <ColumnChart stacked height={240} data={shaped(a.activity, [{ key: 'posts', label: 'Beiträge', values: a.activity.map((x: any) => x.posts) }, { key: 'comments', label: 'Kommentare', values: a.activity.map((x: any) => x.comments) }])} />
            </Sec>
            <Sec title="Umsatz nach Stufe" lead="Monatlich wiederkehrend, netto (Jahresbeiträge geteilt durch 12, ohne Testphasen und Einmalzahlungen).">
              {a.revenue.by_tier.length ? (
                <div className="table-wrap" style={{ border: 0 }}>
                  <table className="t cma-table">
                    <thead>
                      <tr>
                        <th>Stufe</th>
                        <th>Mitglieder</th>
                        <th>MRR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.revenue.by_tier.map((t: any) => (
                        <tr key={t.tier_id}>
                          <td>{t.name}</td>
                          <td>{t.members}</td>
                          <td>{euro(t.mrr_cents, a.revenue.currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted">Noch keine Mitgliedschaften mit Stufe.</p>
              )}
              {a.revenue.trial_mrr_cents > 0 && <p className="muted small">Dazu kommen {euro(a.revenue.trial_mrr_cents, a.revenue.currency)} im Monat, sobald die laufenden Testphasen bezahlt werden. Einmalzahlungen im Zeitraum: {euro(a.revenue.one_time_cents, a.revenue.currency)}.</p>}
            </Sec>
            <Sec title="Aktivste Mitglieder" lead="Nach Punkten im Zeitraum.">
              {a.top_contributors.length ? (
                <ul className="cma-list">
                  {a.top_contributors.map((c: any, i: number) => (
                    <li key={c.contact_id}>
                      <b style={{ width: 24, textAlign: 'right' }}>{i + 1}</b>
                      <div className="grow">
                        <div>
                          <strong>{c.name}</strong>
                        </div>
                        <div className="muted small">
                          {c.posts} Beiträge · {c.comments} Kommentare
                        </div>
                      </div>
                      <b>{c.points}</b>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Im Zeitraum hat noch niemand Punkte gesammelt.</p>
              )}
            </Sec>
          </SortableGrid>
        </>
      )}
    </div>
  );
}
