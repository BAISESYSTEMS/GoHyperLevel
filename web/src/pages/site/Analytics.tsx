import { useState } from 'react';
import { api } from '../../api';
import { Badge, Empty, Spinner, Stat, useLoad } from '../../ui';
import './site.css';
import { getLocale, intlLocale, useT } from '../../i18n';
import { SOURCE_LOCALE } from '../../i18n/registry';
import { SortableGrid } from '../../sortable/Sortable';

// Numbers in the UI language (German as before: "12,5 %", English "12.5%").
const eur = (c: number) => new Intl.NumberFormat(intlLocale(), { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 }).format(c / 100);
const pct = (v: number, d = 1) => (getLocale() === SOURCE_LOCALE ? `${(v * 100).toFixed(d).replace('.', ',')} %` : `${(v * 100).toFixed(d)}%`);
const num = (n: number) => new Intl.NumberFormat(intlLocale()).format(n);
const secs = (s: number) => (s >= 90 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`);
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// German labels (message ids of the sites catalog), shown through t()
const RANGES: [number, string][] = [[7, '7 Tage'], [30, '30 Tage'], [90, '90 Tage'], [365, '12 Monate']];
const KIND: Record<string, string> = { form: 'Formulare', booking: 'Termine', purchase: 'Käufe' };

/** Views → conversions per step with drop-off, the A/B test of each step, revenue and where visitors came from. */
export function AnalyticsTab({ funnel }: { funnel: any }) {
  const t = useT('sites');
  const [days, setDays] = useState(30);
  const from = ymd(new Date(Date.now() - (days - 1) * 864e5));
  const r = useLoad(() => api.get<any>(`/api/funnels/${funnel.id}/analytics?from=${from}`), [funnel.id, days]);
  const d = r.data;
  if (!d) return r.error ? <Empty>{r.error}</Empty> : <Spinner />;
  const first = d.steps[0]?.visitors || 0;
  const maxDaily = Math.max(1, ...d.daily.map((x: any) => x.visitors));
  const csv = `/api/funnels/${funnel.id}/analytics.csv?from=${from}&locationId=${encodeURIComponent(localStorage.getItem('pghl.location') ?? '')}`;
  const none = d.totals.views === 0;

  return (
    <div className="an site-tab" data-tour="site-analytics">
      <div className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
        <div className="tabs" style={{ margin: 0 }}>
          {RANGES.map(([n, l]) => (
            <button key={n} className={n === days ? 'on' : ''} onClick={() => setDays(n)} aria-pressed={n === days}>
              {t(l)}
            </button>
          ))}
        </div>
        <span className="grow" />
        <a className="btn secondary" href={csv}>
          {t('CSV herunterladen')}
        </a>
      </div>

      {!d.funnel.analytics_enabled && <p className="notice small">{t('Die Zählung ist für diese Website ausgeschaltet (Design → Statistik). Es kommen keine neuen Zahlen dazu.')}</p>}

      <SortableGrid id="site-analytics.stats" className="stats">
        <Stat label={t('Besucher')} value={num(d.totals.visitors)} sub={t.plural(d.totals.views, { other: '{n} Aufrufe' }, { n: num(d.totals.views) })} />
        <Stat label={t('Conversions')} value={num(d.totals.conversions)} sub={t('{pct} der Besucher', { pct: pct(d.totals.conv_rate) })} />
        <Stat label={t('Erreichen den letzten Schritt')} value={d.steps.length > 1 ? pct(d.totals.reach_last) : '–'} sub={d.steps.length > 1 ? t('von der ersten Seite') : t('nur eine Seite')} />
        <Stat label={t('Umsatz (Käufe auf den Seiten)')} value={eur(d.totals.revenue_cents)} sub={d.attribution ? t('Attribution: {amount} (letzter Kontakt)', { amount: eur(d.attribution.last.revenue_cents) }) : undefined} />
      </SortableGrid>

      {none ? (
        <Empty>{t('Im gewählten Zeitraum gab es noch keine Aufrufe. Besucher werden ohne Cookies und ohne Einwilligung gezählt; Bots und Besucher mit „Do Not Track“ zählen nicht.')}</Empty>
      ) : (
        <div className="card" style={{ marginTop: 14 }}>
          <h3>{t('Schritte des Funnels')}</h3>
          <ol className="an-steps">
            {d.steps.map((s: any, i: number) => {
              const w = first ? Math.max(2, Math.round((s.visitors / first) * 100)) : 0;
              const next = d.steps[i + 1];
              return (
                <li key={s.page_id}>
                  <div className="an-step">
                    <div className="an-name">
                      <b>
                        {i + 1}. {s.name}
                      </b>{' '}
                      <a className="muted small" href={s.url} target="_blank" rel="noreferrer">
                        /{s.slug}
                      </a>
                    </div>
                    <div className="an-bar" role="img" aria-label={t('{n} Besucher, {pct} der ersten Seite', { n: s.visitors, pct: first ? pct(s.visitors / first, 0) : pct(0, 0) })}>
                      <i style={{ width: `${w}%` }} />
                      <span>
                        {t.plural(s.visitors, { other: '{n} Besucher' }, { n: num(s.visitors) })}
                        {first ? ` · ${pct(s.visitors / first, 0)}` : ''}
                      </span>
                    </div>
                    <div className="an-meta small">
                      <span>{t.plural(s.views, { other: '{n} Aufrufe' }, { n: num(s.views) })}</span>
                      {s.avg_seconds > 0 && <span>{t('Ø {time} auf der Seite', { time: secs(s.avg_seconds) })}</span>}
                      {s.avg_scroll > 0 && <span>{t('Ø {n} % gescrollt', { n: Math.round(s.avg_scroll) })}</span>}
                      {(['form', 'booking', 'purchase'] as const).map((k) => s.conversions[k] > 0 && <span key={k}>{t(KIND[k])}: <b>{s.conversions[k]}</b></span>)}
                      {s.conversions.total > 0 && <Badge tone="green">{pct(s.conv_rate)} {t('Conversion')}</Badge>}
                      {s.revenue_cents > 0 && <Badge tone="purple">{eur(s.revenue_cents)}</Badge>}
                    </div>
                    {s.ab && (
                      <details className="an-ab">
                        <summary className="small">
                          {t('A/B-Test „{name}“', { name: s.ab.name })} · {s.ab.status === 'running' ? t('läuft') : s.ab.status === 'ended' ? t('beendet') : s.ab.status}
                          {s.ab.leader ? ` · ${t('vorn: {name}', { name: s.ab.variants.find((v: any) => v.key === s.ab.leader)?.name ?? s.ab.leader })}` : ''}
                        </summary>
                        <table className="an-table small">
                          <thead>
                            <tr>
                              <th>{t('Variante')}</th>
                              <th>{t('Besucher')}</th>
                              <th>{t('Conversions')}</th>
                              <th>{t('Rate')}</th>
                              <th>{t('Uplift')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {s.ab.variants.map((v: any) => (
                              <tr key={v.key}>
                                <td>{v.name}</td>
                                <td>{num(v.visitors)}</td>
                                <td>{num(v.conversions)}</td>
                                <td>{typeof v.rate === 'number' ? pct(v.rate) : '–'}</td>
                                <td>{typeof v.uplift === 'number' ? `${v.uplift > 0 ? '+' : ''}${pct(v.uplift, 0)}` : '–'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {s.ab.small_sample && <p className="muted small">{t('Noch wenige Besucher – das Ergebnis ist nicht belastbar.')}</p>}
                      </details>
                    )}
                  </div>
                  {next && (
                    <div className={`an-drop small${s.drop_off >= 0.6 ? ' high' : ''}`}>
                      ↓ {t('{n} gehen weiter ({pct})', { n: num(s.continued), pct: pct(s.continue_rate, 0) })} · <b>{t('{pct} springen ab', { pct: pct(s.drop_off, 0) })}</b>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          <p className="muted small">{t('„Weiter“ zählt Besucher, die am selben Tag eine spätere Seite des Funnels gesehen haben. Conversions kommen aus Formularen, Terminbuchungen und Käufen, die von dieser Seite ausgingen.')}</p>
        </div>
      )}

      {!none && (
        <SortableGrid id="site-analytics.cards" className="grid2" style={{ marginTop: 14 }}>
          <div className="card">
            <h3>{t('Besucher pro Tag')}</h3>
            <div className="an-days" role="img" aria-label={t('Besucher pro Tag')}>
              {d.daily.map((x: any) => (
                <i key={x.day} style={{ height: `${Math.max(3, (x.visitors / maxDaily) * 100)}%` }} title={t('{day}: {visitors} Besucher, {conversions} Conversions', { day: x.day, visitors: x.visitors, conversions: x.conversions })} />
              ))}
            </div>
          </div>
          <div className="card">
            <h3>{t('Woher & womit')}</h3>
            <table className="an-table small">
              <tbody>
                {d.sources.slice(0, 6).map((s: any) => (
                  <tr key={s.source}>
                    <td>{s.source}</td>
                    <td className="r">{num(s.visitors)}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={2} className="muted">
                    {t('Geräte')}
                  </td>
                </tr>
                {Object.entries(d.devices).map(([k, n]) => (
                  <tr key={k}>
                    <td>{{ desktop: t('Desktop'), tablet: t('Tablet'), phone: t('Handy'), mobile: t('Handy') }[k] ?? k}</td>
                    <td className="r">{num(n as number)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SortableGrid>
      )}

      {d.attribution && (
        <div className="card" style={{ marginTop: 14 }}>
          <h3>{t('Umsatz laut Attribution')}</h3>
          <p className="muted small">{t('Bezahlte Rechnungen (inkl. Stripe), deren Kontakte über diesen Funnel ins CRM kamen – je nach Modell dem ersten oder dem letzten Kontakt zugerechnet (Werbung → Attribution).')}</p>
          <table className="an-table small">
            <thead>
              <tr>
                <th>{t('Modell')}</th>
                <th>{t('Leads')}</th>
                <th>{t('Kunden')}</th>
                <th>{t('Gewonnene Deals')}</th>
                <th>{t('Umsatz')}</th>
              </tr>
            </thead>
            <tbody>
              {(['first', 'last'] as const).map((m) => (
                <tr key={m}>
                  <td>{m === 'first' ? t('Erster Kontakt') : t('Letzter Kontakt')}</td>
                  <td>{d.attribution[m].leads}</td>
                  <td>{d.attribution[m].customers}</td>
                  <td>{d.attribution[m].deals_won}</td>
                  <td>{eur(d.attribution[m].revenue_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">{t('Gezählt wird ohne Cookies: ein täglich wechselnder Hash aus Adresse und Browser, nie die Adresse selbst; Aufbewahrung {n} Tage. Nenne die Reichweitenmessung in deiner Datenschutzerklärung.', { n: d.funnel.retention_days })}</p>
    </div>
  );
}
