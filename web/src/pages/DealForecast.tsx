import { useState } from 'react';
import { amount, api } from '../api';
import { fmtDate, useT } from '../i18n';
import { Spinner, useLoad } from '../ui';
import './crm-gaps.css';

/**
 * Opportunities → "Prognose & Risiken" (modules/deal-forecast.ts): weighted forecast per close month and the cards that make it
 * unreliable (no close date, overdue, no activity for 14 days, no owner). Folded by default; the open state is remembered.
 */

interface Card {
  count: number;
  value: number;
  deals: { id: string; name: string; value: number; expected_close_date: string | null }[];
}
interface Forecast {
  open: { count: number; value: number; weighted: number };
  months: { month: string; count: number; value: number; weighted: number }[];
  later: { count: number; value: number; weighted: number };
  risks: { no_close_date: Card; overdue: Card; stale: Card; no_owner: Card };
}

const KEY = 'pghl.deal-forecast.open';
const readOpen = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

export function DealForecastPanel({ pipelineId }: { pipelineId: string }) {
  const t = useT('crmgaps');
  const [open, setOpen] = useState(readOpen);
  const data = useLoad(() => (open ? api.get<Forecast>(`/api/deal-forecast?months=6${pipelineId ? `&pipeline_id=${encodeURIComponent(pipelineId)}` : ''}`) : Promise.resolve(null)), [open, pipelineId]);
  const f = data.data;
  const max = Math.max(1, ...(f?.months ?? []).map((m) => m.value));
  const month = (ym: string) => fmtDate(`${ym}-15`, { month: 'short', year: '2-digit' });
  const CARDS: [keyof Forecast['risks'], string][] = [
    ['overdue', 'Abschluss überfällig'],
    ['no_close_date', 'Ohne Abschlussdatum'],
    ['stale', 'Seit 14 Tagen ohne Aktivität'],
    ['no_owner', 'Ohne Zuständigen'],
  ];
  return (
    <details
      className="card deal-forecast"
      open={open}
      onToggle={(e) => {
        const now = (e.currentTarget as HTMLDetailsElement).open;
        setOpen(now);
        try {
          localStorage.setItem(KEY, now ? '1' : '0');
        } catch {
          /* private mode */
        }
      }}
      data-tour="opps-forecast"
    >
      <summary>
        <strong>{t('Prognose & Risiken')}</strong>
        {f && <span className="muted small"> · {t('{n} offen · {v} · gewichtet {w}', { n: f.open.count, v: amount(f.open.value), w: amount(f.open.weighted) })}</span>}
      </summary>
      {open && !f ? (
        <Spinner />
      ) : f ? (
        <div className="forecast-body">
          <div className="forecast-months" role="table" aria-label={t('Gewichtete Prognose je Abschlussmonat')}>
            {f.months.map((m) => (
              <div key={m.month} className="forecast-month" role="row" title={t('{n} Deals · {v} · gewichtet {w}', { n: m.count, v: amount(m.value), w: amount(m.weighted) })}>
                <div className="forecast-bar" aria-hidden="true">
                  <span className="all" style={{ height: `${(m.value / max) * 100}%` }} />
                  <span className="weighted" style={{ height: `${(m.weighted / max) * 100}%` }} />
                </div>
                <div className="small" role="cell">{month(m.month)}</div>
                <div className="small" role="cell">
                  <strong>{amount(m.weighted)}</strong>
                </div>
                <div className="muted small" role="cell">
                  {amount(m.value)}
                </div>
              </div>
            ))}
          </div>
          <p className="muted small">{t('Balken: Summe der Deals (hell) und gewichtet nach Stufen-Wahrscheinlichkeit (kräftig). Überfällige zählen im aktuellen Monat; später: {v}.', { v: amount(f.later.value) })}</p>
          <div className="forecast-risks">
            {CARDS.map(([k, label]) => {
              const c = f.risks[k];
              return (
                <div key={k} className={`forecast-risk${c.count ? ' warn' : ''}`}>
                  <div className="small">{t(label)}</div>
                  <strong>{c.count}</strong> <span className="muted small">{amount(c.value)}</span>
                  {c.deals.length > 0 && <div className="muted small">{c.deals.slice(0, 3).map((d) => d.name).join(', ')}</div>}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </details>
  );
}
