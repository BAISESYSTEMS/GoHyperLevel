import { useEffect, useState } from 'react';
import { Icon } from '../icons';
import { api, d } from '../api';
import { Link, Select, useLoad } from '../ui';
import { PriorityBadge, SlaChip, StatusBadge } from './Tickets';
import { useT } from '../i18n';

/** Customer health score: badge, contact-list column + filter, and the "Service" card on the contact page. */

/** [German label (message id of the contacts catalog), css class] */
const BAND: Record<string, [string, string]> = { green: ['Gut', 'good'], yellow: ['Mittel', 'warn'], red: ['Kritisch', 'bad'] };

export function HealthBadge({ score, band, compact }: { score: number; band: string; compact?: boolean }) {
  // Badge and filter are part of the contact list: translated with it (contacts catalog).
  const t = useT('contacts');
  const [german, cls] = BAND[band] ?? ['–', 'none'];
  const label = t(german);
  return (
    <span className={`health ${cls}`} title={t('Health-Score {score}/100 · {label}', { score, label })}>
      <i aria-hidden="true" />
      {score}
      {!compact && <span className="health-label"> {label}</span>}
    </span>
  );
}

/** Filter for the contact list (and smart lists): green / yellow / red. */
export function HealthFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT('contacts');
  return (
    <div style={{ width: 160 }} data-tour="contacts-health">
      <Select value={value} onChange={onChange} placeholder={t('Health: alle')} options={[['green', t('Health: gut')], ['yellow', t('Health: mittel')], ['red', t('Health: kritisch')]]} />
    </div>
  );
}

/** Scores for the contacts on the current page (one request). */
export function useHealthScores(ids: string[]) {
  const key = ids.join(',');
  const [map, setMap] = useState<Record<string, { score: number; band: string }>>({});
  useEffect(() => {
    if (!key) return setMap({});
    let on = true;
    api
      .get(`/api/health/scores?ids=${encodeURIComponent(key)}`)
      .then((r) => on && setMap(r))
      .catch(() => on && setMap({}));
    return () => {
      on = false;
    };
  }, [key]);
  return map;
}

const FACES = ['😞', '🙁', '😐', '🙂', '😄'];

export function ContactService({ contactId }: { contactId: string }) {
  const { data, error } = useLoad(() => api.get(`/api/contacts/${contactId}/service`), [contactId]);
  const [open, setOpen] = useState(false);
  if (error || !data) return null;
  const h = data.health;
  return (
    <div className="card contact-service" data-tour="contact-service">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>
          <Icon name="service" size={16} /> Service
        </h2>
        {h && <HealthBadge score={h.score} band={h.band} />}
      </div>
      {h && (
        <>
          <div className="health-meter" aria-hidden="true">
            <div className={BAND[h.band]?.[1]} style={{ width: `${h.score}%` }} />
          </div>
          <button className="linkbtn small" onClick={() => setOpen(!open)}>
            {open ? 'Signale ausblenden' : 'Wie entsteht der Wert?'}
          </button>
          {open && (
            <table className="t health-signals">
              <tbody>
                {h.signals
                  .filter((s: any) => s.weight > 0)
                  .map((s: any) => (
                    <tr key={s.key}>
                      <td>{s.label}</td>
                      <td style={{ textAlign: 'right' }}>{s.score === null ? <span className="muted">keine Daten</span> : s.score}</td>
                      <td className="muted small" style={{ textAlign: 'right' }}>
                        ×{s.weight}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </>
      )}
      <h3 className="cs-sub">
        Tickets {data.open ? <span className="muted">({data.open} offen)</span> : null}
      </h3>
      {data.tickets.length ? (
        data.tickets.slice(0, 5).map((t: any) => (
          <div key={t.id} className="cs-ticket">
            <Link to={`tickets/${t.id}`}>
              #{t.number} {t.subject}
            </Link>
            <div className="row" style={{ gap: 6, alignItems: 'center' }}>
              <StatusBadge t={t} /> <PriorityBadge p={t.priority} /> <SlaChip t={t} />
            </div>
          </div>
        ))
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          Keine Tickets.
        </p>
      )}
      {(data.surveys.csat.length > 0 || data.surveys.nps.length > 0) && (
        <>
          <h3 className="cs-sub">Umfragen</h3>
          {data.surveys.csat.slice(0, 3).map((c: any) => (
            <div key={c.id} className="small">
              {FACES[c.csat_score - 1]} CSAT {c.csat_score}/5 · #{c.number} <span className="muted">{d(c.csat_at)}</span>
            </div>
          ))}
          {data.surveys.nps.slice(0, 3).map((n: any, i: number) => (
            <div key={i} className="small">
              NPS {n.score}/10 · {n.campaign} <span className="muted">{d(n.updated_at)}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
