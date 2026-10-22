import { useState } from 'react';
import { api, dt, euro, moneyList, name } from '../api';
import { Link, PageHead, Select, Spinner, Stat, useLoad } from '../ui';
import { PluginWidgets } from '../werkstatt/PluginFrame';
import { useModules } from '../theme/store';
import { fmtDate, useT } from '../i18n';
import { LearnLink } from '../tour/learn';
import { AcademyWelcome } from '../tour/welcome';
import { MoreFields, useSimple } from '../areas/fields';
import { dashboardLayout, type DashCard, type DashStat } from '../areas/easy-core';
import { SortableGrid } from '../sortable/lazy';
import '../areas/easy-core.css';

/** The calendar day (YYYY-MM-DD) n days from `ymd`. Its own two lines: importing the planner's date helpers (pm-format.ts) put all of
 *  them into the first download (tests/bundle-budget.test.ts). */
const addDay = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/** A local calendar day (YYYY-MM-DD) in the UI language: "Mo., 6. Okt. 2026" / "Mon, 6 Oct 2026". */
const fmtDay = (ymd: string) => fmtDate(`${ymd}T00:00:00Z`, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

/** `today` and the days of `data` are the sub-account's local dates (from the server), not the browser's UTC date. */
function LeadsChart({ data, days, today }: { data: { day: string; n: number }[]; days: number; today: string }) {
  const t = useT('dashboard');
  const map = new Map(data.map((d) => [d.day, d.n]));
  const series = Array.from({ length: days }, (_, i) => {
    const day = addDay(today, -(days - 1 - i));
    return { day, n: map.get(day) ?? 0 };
  });
  const max = Math.max(1, ...series.map((s) => s.n));
  const w = 100 / series.length;
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" style={{ width: '100%', height: 140 }} role="img" aria-label={t('Neue Kontakte pro Tag')}>
      {series.map((s, i) => (
        <rect key={s.day} x={i * w + w * 0.15} width={w * 0.7} y={40 - (s.n / max) * 38} height={(s.n / max) * 38} rx={0.6} fill="var(--brand)">
          <title>
            {fmtDay(s.day)}: {s.n}
          </title>
        </rect>
      ))}
    </svg>
  );
}

export function Dashboard() {
  const t = useT('dashboard');
  const [days, setDays] = useState('30');
  const { data, loading } = useLoad(() => api.get(`/api/dashboard?days=${days}`), [days]);
  // Areas hidden in Darstellung → Sichtbare Bereiche take their widgets with them.
  const { visible } = useModules();
  // Einfach-Modus: only what calls for action today; the rest behind one "Mehr anzeigen" (web/src/areas/easy-core.ts).
  const simple = useSimple();
  if (loading && !data) return <Spinner />;
  if (!data) return null;
  const layout = dashboardLayout(simple, visible);
  const conv = data.appointments.showed + data.appointments.noshow ? Math.round((data.appointments.showed / (data.appointments.showed + data.appointments.noshow)) * 100) : null;
  const range = <Select value={days} onChange={setDays} aria={t('Zeitraum')} options={[['7', t('Letzte 7 Tage')], ['30', t('Letzte 30 Tage')], ['90', t('Letzte 90 Tage')], ['365', t('Letztes Jahr')]]} />;
  const stat = (k: DashStat) => {
    switch (k) {
      case 'contacts':
        return <Stat key={k} label={t('Neue Kontakte')} value={data.contacts.new} sub={t('{n} gesamt', { n: data.contacts.total })} />;
      case 'pipeline':
        return <Stat key={k} label={t('Offene Pipeline')} value={euro(data.opportunities.openValue)} sub={t('{n} Opportunities', { n: data.opportunities.open })} />;
      case 'won':
        return <Stat key={k} label={t('Gewonnen')} value={euro(data.opportunities.wonValue)} sub={t('{won} gewonnen · {lost} verloren', { won: data.opportunities.won, lost: data.opportunities.lost })} />;
      case 'booked':
        return <Stat key={k} label={t('Termine gebucht')} value={data.appointments.booked} sub={`${t('{n} anstehend', { n: data.appointments.upcoming })}${conv !== null ? ` · ${t('{n}% Show-Rate', { n: conv })}` : ''}`} />;
      case 'forms':
        return <Stat key={k} label={t('Formular-Einsendungen')} value={data.forms.submissions} />;
      case 'messages':
        return <Stat key={k} label={t('Nachrichten')} value={data.messages.sent} sub={t('{received} empfangen · {unread} ungelesen', { received: data.messages.received, unread: data.messages.unread })} />;
      case 'revenue': {
        // per currency, never added up (100 € + 100 $ is not 200 €)
        const rows: { currency: string; paid: number; outstanding: number }[] = data.revenue.by_currency ?? [{ currency: data.revenue.currency ?? 'EUR', paid: data.revenue.paid, outstanding: data.revenue.outstanding }];
        const list = (key: 'paid' | 'outstanding') => moneyList(rows.filter((r) => r[key]).map((r) => [r.currency, r[key]]), data.revenue.currency);
        return <Stat key={k} label={t('Umsatz bezahlt')} value={list('paid')} sub={t('{amount} offen', { amount: list('outstanding') })} />;
      }
      case 'reviews':
        return <Stat key={k} label={t('Bewertungen')} value={data.reviews.average?.a ? `${data.reviews.average.a} ★` : '–'} sub={t.plural(data.reviews.average?.n ?? 0, { one: '{n} Bewertung', other: '{n} Bewertungen' })} />;
      case 'tasks':
        return (
          <Stat
            key={k}
            label={t('Offene Aufgaben')}
            value={data.tasks.open}
            sub={<Link to="tasks" className={data.tasks.overdue ? 'dash-late' : undefined}>{data.tasks.overdue ? t('{n} überfällig', { n: data.tasks.overdue }) : t('Zu den Aufgaben')}</Link>}
          />
        );
      case 'unread':
        return <Stat key={k} label={t('Ungelesene Nachrichten')} value={data.messages.unread} sub={<Link to="conversations">{t('Zum Posteingang')}</Link>} />;
      case 'upcoming':
        return <Stat key={k} label={t('Anstehende Termine')} value={data.appointments.upcoming} sub={<Link to="calendars">{t('Zum Kalender')}</Link>} />;
    }
  };
  const card = (k: DashCard) => {
    switch (k) {
      case 'leads':
        return (
          <div className="card" key={k} data-tour="dashboard-leads">
            <h2>{t('Neue Kontakte pro Tag')}</h2>
            <LeadsChart data={data.leadsPerDay} days={Number(days) > 90 ? 90 : Number(days)} today={data.today} />
          </div>
        );
      case 'next':
        return (
          <div className="card" key={k} data-tour="dashboard-next">
            <h2>{t('Nächste Termine')}</h2>
            {visible('calendars') &&
              (data.appointments.next.length ? (
                <ul className="timeline">
                  {data.appointments.next.map((a: any) => (
                    <li key={a.id}>
                      <strong>{dt(a.start_at)}</strong> <span>{a.title || name(a)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">
                  {t('Keine anstehenden Termine.')} <Link to="calendars">{t('Kalender einrichten')}</Link>
                </p>
              ))}
            {/* Einfach-Modus has its own tile for the tasks – not said twice */}
            {visible('tasks') && !layout.stats.includes('tasks') && data.tasks.open > 0 && (
              <p>
                <Link to="tasks">
                  {t.plural(data.tasks.open, { one: '{n} offene Aufgabe', other: '{n} offene Aufgaben' })}
                  {data.tasks.overdue ? ` (${t('{n} überfällig', { n: data.tasks.overdue })})` : ''}
                </Link>
              </p>
            )}
          </div>
        );
      case 'pipelines':
        return data.pipelines.map((p: any) => {
          const max = Math.max(1, ...p.stages.map((s: any) => s.count));
          return (
            <div className="card" key={p.id} data-tour="dashboard-pipeline">
              <h2>
                {t('Pipeline:')} <Link to={`/app/opportunities?pipeline=${p.id}`}>{p.name}</Link>
              </h2>
              {p.stages.map((s: any) => (
                <div key={s.id} style={{ marginBottom: 8 }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span>{s.name}</span>
                    <span className="muted">
                      {s.count} · {euro(s.value)}
                    </span>
                  </div>
                  <div className="bar">
                    <div style={{ width: `${(s.count / max) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          );
        });
      case 'sources':
        return (
          <div className="card" key={k} data-tour="dashboard-sources">
            <h2>{t('Lead-Quellen')}</h2>
            {data.sources.length ? (
              <table className="t">
                <tbody>
                  {data.sources.map((s: any) => (
                    <tr key={s.source}>
                      <td>{s.source}</td>
                      <td style={{ textAlign: 'right' }}>{s.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">{t('Noch keine Kontakte im Zeitraum.')}</p>
            )}
          </div>
        );
    }
  };
  const hasMore = layout.moreStats.length > 0 || layout.moreCards.length > 0 || layout.widgetsInMore;
  return (
    <>
      <PageHead title={t('Dashboard')}>
        {visible('reports') && (
          <Link to="reports" className="btn secondary">
            {t('Eigene Dashboards')}
          </Link>
        )}
        {/* the period only changes the numbers behind "Mehr anzeigen" in Einfach-Modus – it sits there */}
        {!simple && range}
        <LearnLink label="learn" />
      </PageHead>
      <AcademyWelcome />
      {/* Every tile and card can be dragged into your own order (web/src/sortable). The essential row of Einfach-Modus and the
          one behind "Mehr anzeigen" share one saved order with the full row, so switching modes keeps it. */}
      {layout.stats.length > 0 && (
        <SortableGrid id="dashboard.stats" className="stats" data-tour="dashboard-stats">
          {layout.stats.map(stat)}
        </SortableGrid>
      )}
      {!layout.widgetsInMore && <PluginWidgets />}
      {layout.cards.length > 0 && (
        <SortableGrid id="dashboard.cards" className="grid2" style={{ gap: 14 }}>
          {layout.cards.flatMap(card)}
        </SortableGrid>
      )}
      {simple && hasMore && (
        <MoreFields id="dashboard" label={t('Mehr anzeigen')}>
          <div className="dash-range">{range}</div>
          {layout.moreStats.length > 0 && (
            <SortableGrid id="dashboard.stats" className="stats">
              {layout.moreStats.map(stat)}
            </SortableGrid>
          )}
          <PluginWidgets />
          {layout.moreCards.length > 0 && (
            <SortableGrid id="dashboard.cards" className="grid2" style={{ gap: 14 }}>
              {layout.moreCards.flatMap(card)}
            </SortableGrid>
          )}
        </MoreFields>
      )}
    </>
  );
}
