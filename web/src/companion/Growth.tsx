import { useState } from 'react';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { api } from '../api';
import { useT } from '../i18n';
import { Check, Field, Select, act } from '../ui';
import { openCheckin, type CompanionPrefs } from './store';

/**
 * Jarvis als Business Developer (docs/living-boards.md#business-developer) in the browser: the role (companion tab), the
 * Wachstums-Briefing and the Wochenbilanz (proactive tab – three settings, nothing more) and the week's numbers above the items of a
 * growth check-in. The review itself is computed on the server (server/modules/companion-growth.ts).
 */

type Save = (patch: { role?: CompanionPrefs['role']; growth?: Partial<CompanionPrefs['growth']> }) => unknown;

export function RoleField({ p, save }: { p: CompanionPrefs; save: Save }) {
  const t = useT('companion');
  return (
    <Field label={t('Rolle')} hint={p.role === 'business_developer' ? t('Denkt ans ganze Geschäft – Umsatz, Leads, Kunden, Marketing, Engpässe – antwortet mit Zahlen und schlägt 1–3 Schritte vor, die er vorbereitet.') : t('Beantwortet Fragen und erledigt Aufgaben, ohne von sich aus aufs Geschäft zu schauen.')}>
      <Select
        value={p.role}
        onChange={(v) => void save({ role: v as CompanionPrefs['role'] })}
        options={[
          ['business_developer', t('Business Developer (Standard)')],
          ['assistant', t('Assistent')],
        ]}
      />
    </Field>
  );
}

export function GrowthBriefingFields({ p, save, name, onClose }: { p: CompanionPrefs; save: Save; name: string; onClose: () => void }) {
  const t = useT('companion');
  const g = p.growth;
  const [busy, setBusy] = useState(false);
  const tryNow = async () => {
    setBusy(true);
    const r = await act(() => api.post<{ checkin_id: string }>('/api/companion/growth/run', { kind: new Date().getDay() === 1 && g.daily && g.weekly ? 'weekly' : 'daily' }));
    setBusy(false);
    if (r?.checkin_id) {
      onClose();
      openCheckin(r.checkin_id);
    }
  };
  return (
    <>
      <h3 className="cmp-set-h">
        <TrendingUp size={15} /> {t('Wachstums-Briefing')}
      </h3>
      {/* opt-in: off until the person switches it on; the Wochenbilanz follows the switch */}
      <div className="cmp-row">
        <Check checked={g.daily} onChange={(v) => void save({ growth: { daily: v } })} label={g.daily ? t('Täglich um') : t('Wachstums-Briefing einschalten')} />
        {g.daily && <input type="time" defaultValue={g.time} aria-label={t('Uhrzeit des Wachstums-Briefings')} onBlur={(e) => e.target.value && e.target.value !== g.time && void save({ growth: { time: e.target.value } })} />}
      </div>
      {g.daily && <Check checked={g.weekly} onChange={(v) => void save({ growth: { weekly: v } })} label={t('Montags die Wochenbilanz (Kennzahlen zur Vorwoche)')} />}
      <p className="cmp-note">{t('Top-3-Chancen und -Risiken mit Euro-Betrag und eine Wachstumsidee aus deinen Zahlen – nur wenn es Neues gibt, nie in der Ruhezeit. {name} bereitet Entwürfe vor, gesendet wird nur per Klick.', { name })}</p>
      <div className="cmp-actions">
        <button type="button" className="btn secondary small" onClick={() => void tryNow()} disabled={busy}>
          {busy ? t('Wird erstellt …') : t('Wachstums-Briefing jetzt ansehen')}
        </button>
      </div>
    </>
  );
}

export interface GrowthView {
  kind: 'daily' | 'weekly';
  kpis: Record<string, number | null>;
  prev: Record<string, number | null>;
  deltas: Record<string, number | null>;
}

const money = (v: number | null | undefined, locale: string) => new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Math.round(Number(v) || 0));

/** The week's numbers of a growth check-in: revenue, new leads, deals won, win rate, open pipeline – with the change to last week. */
export function GrowthKpis({ g, locale }: { g: GrowthView; locale: string }) {
  const t = useT('companion');
  const k = g.kpis;
  const rows: [string, string, number | null][] = [
    [t('Umsatz (7 Tage)'), money(k.revenue, locale), g.deltas.revenue],
    [t('Neue Leads'), String(k.leads ?? 0), g.deltas.leads],
    [t('Gewonnen'), `${k.won_count ?? 0} · ${money(k.won_value, locale)}`, g.deltas.won_value],
    [t('Abschlussquote'), k.win_rate === null || k.win_rate === undefined ? '–' : `${Math.round(Number(k.win_rate) * 100)} %`, null],
    [t('Offene Pipeline'), money(k.pipeline, locale), null],
  ];
  return (
    <section className="cmp-growth" aria-label={g.kind === 'weekly' ? t('Wochenbilanz') : t('Wachstums-Briefing')}>
      <dl className="cmp-growth-kpis">
        {rows.map(([label, value, d]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              {value}
              {d !== null && d !== undefined && d !== 0 && (
                <small className={d > 0 ? 'up' : 'down'}>
                  {d > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />} {d > 0 ? '+' : '−'}
                  {Math.abs(d)} %
                </small>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
