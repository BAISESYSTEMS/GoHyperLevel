import { useState } from 'react';
import { api } from '../api';
import { Avatar, addDay, fmtShort, fmtWeekday, fmtMinutes, isWeekend, mondayOf, todayIn, useStored, type Meta, type ProjectDetail } from './PmKit';
import { useLoad } from '../ui';
import { useT } from '../i18n';

/** Workload per person: estimates spread over the days a task runs, against the weekly capacity; time actually logged as a bar. */

interface Row {
  id: string;
  name: string;
  load: Record<string, number>;
  logged: Record<string, number>;
  total_minutes: number;
  capacity_minutes: number;
  tasks: number;
}
interface Workload {
  from: string;
  to: string;
  days: string[];
  today: string;
  capacity_per_day_minutes: number;
  weekend_days: string[];
  people: Row[];
  unassigned: Row;
}

const hoursText = (min: number) => {
  const h = Math.round((min / 60) * 10) / 10;
  return h ? `${String(h).replace('.', ',')}` : '';
};

export function PmWorkload({ project, meta, version }: { project: ProjectDetail; meta: Meta; version: number }) {
  const t = useT('pm');
  const today = todayIn(meta.timezone);
  const [from, setFrom] = useState(mondayOf(today));
  const [scope, setScope] = useStored<'project' | 'all'>('wl-scope', 'project');
  const w = useLoad(() => api.get<Workload>(`/api/pm/workload?from=${from}&to=${addDay(from, 27)}${scope === 'project' ? `&project_id=${project.id}` : ''}`), [from, scope, version, project.id]);
  const d = w.data;
  if (w.error && !d) return <p className="pm-error">{w.error}</p>;
  if (!d) return <div className="pm-loading">{t('Auslastung lädt…')}</div>;
  const perDay = d.capacity_per_day_minutes;
  const rows = [...d.people.filter((p) => p.total_minutes > 0 || Object.keys(p.logged).length > 0 || p.tasks > 0), ...(d.unassigned.total_minutes > 0 ? [d.unassigned] : [])];
  const weeks: string[][] = [];
  for (let i = 0; i < d.days.length; i += 7) weeks.push(d.days.slice(i, i + 7));
  const level = (min: number, we: boolean) => {
    if (!min) return '';
    const r = min / (perDay || 1);
    return we ? 'l2' : r > 1.001 ? 'over' : r >= 0.75 ? 'l3' : r >= 0.4 ? 'l2' : 'l1';
  };
  return (
    <div className="pm-wl-view" data-tour="pm-workload">
      <div className="pm-cal-bar">
        <div className="actions">
          <button type="button" className="btn small secondary" aria-label={t('Vier Wochen zurück')} onClick={() => setFrom(addDay(from, -28))}>
            ‹
          </button>
          <button type="button" className="btn small secondary" onClick={() => setFrom(mondayOf(today))}>
            {t('Heute')}
          </button>
          <button type="button" className="btn small secondary" aria-label={t('Vier Wochen weiter')} onClick={() => setFrom(addDay(from, 28))}>
            ›
          </button>
        </div>
        <h3 className="pm-cal-title">
          {fmtShort(d.from)} – {fmtShort(d.to)}
        </h3>
        <span className="grow" />
        <div className="pm-seg" role="group" aria-label={t('Umfang')}>
          <button type="button" className={scope === 'project' ? 'on' : ''} aria-pressed={scope === 'project'} onClick={() => setScope('project')}>
            {t('Dieses Projekt')}
          </button>
          <button type="button" className={scope === 'all' ? 'on' : ''} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
            {t('Alle Projekte')}
          </button>
        </div>
      </div>
      {!rows.length ? (
        <p className="pm-empty muted">{t('Keine Aufwandsschätzungen im Zeitraum. Trage bei Aufgaben mit Datum eine Schätzung ein – dann erscheint hier, wer wann wie viel zu tun hat.')}</p>
      ) : (
        <div className="pm-wl-scroll">
          <table className="pm-wl" aria-label={t('Auslastung pro Person')}>
            <thead>
              <tr>
                <th rowSpan={2} className="pm-wl-name">
                  {t('Person')}
                </th>
                {weeks.map((wk) => (
                  <th key={wk[0]} colSpan={7} className="pm-wl-week">
                    ab {fmtShort(wk[0])}
                  </th>
                ))}
                <th rowSpan={2} className="pm-wl-sum">
                  {t('Summe')}
                </th>
              </tr>
              <tr>
                {d.days.map((day) => (
                  <th key={day} className={`pm-wl-day${isWeekend(day) ? ' we' : ''}${day === today ? ' today' : ''}`} title={fmtShort(day)}>
                    {fmtWeekday(day).slice(0, 2)}
                    <small>{Number(day.slice(8))}</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const cap = p.id === 'unassigned' ? 0 : p.capacity_minutes;
                return (
                  <tr key={p.id}>
                    <th className="pm-wl-name" scope="row">
                      {p.id !== 'unassigned' && <Avatar person={p} size={22} />} <span>{p.name}</span> <span className="muted small">{p.tasks} {t('Aufg.')}</span>
                    </th>
                    {d.days.map((day) => {
                      const min = p.load[day] ?? 0;
                      const lg = p.logged[day] ?? 0;
                      const we = isWeekend(day);
                      return (
                        <td key={day} className={`pm-wl-cell ${level(min, we)}${we ? ' we' : ''}${day === today ? ' today' : ''}`} title={`${fmtShort(day)}: ${min ? t('geplant {time}', { time: fmtMinutes(min) }) : t('nichts geplant')}${lg ? t(', erfasst {time}', { time: fmtMinutes(lg) }) : ''}`}>
                          {hoursText(min)}
                          {lg > 0 && <i className="pm-wl-logged" style={{ width: `${Math.min(100, (lg / (perDay || 480)) * 100)}%` }} />}
                        </td>
                      );
                    })}
                    <td className="pm-wl-sum">
                      <strong>{fmtMinutes(p.total_minutes) || '–'}</strong>
                      {cap > 0 && (
                        <div className="pm-bar-track" title={t('Kapazität im Zeitraum: {time}', { time: fmtMinutes(cap) })}>
                          <i style={{ width: `${Math.min(100, (p.total_minutes / cap) * 100)}%`, background: p.total_minutes > cap ? 'var(--red)' : undefined }} />
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small pm-legend-line">
        {t('Stunden pro Tag, gleichmäßig über die Laufzeit jeder Aufgabe verteilt (ohne Wochenende). Kapazität:')} {meta.settings.capacity_hours} {t('Std. pro Woche und Person (')}{fmtMinutes(perDay)} {t('pro Tag) – einstellbar unter Zeiterfassung → Einstellungen. Der dunkle Balken unten in einer Zelle zeigt die erfasste Zeit.')}
      </p>
    </div>
  );
}
