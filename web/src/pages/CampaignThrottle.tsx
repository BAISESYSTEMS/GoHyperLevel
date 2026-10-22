import { useState } from 'react';
import { Field, Input, Select } from '../ui';
import { SPEEDS, durationText, etaText, speedValue } from '../campaign-throttle';
import './quickwins.css';
import { intlLocale, useT } from '../i18n';

const de = (n: number) => n.toLocaleString(intlLocale());

/**
 * Sending speed of a campaign: messages per hour (standard = the default batch per tick), the time it takes and the warm-up hint for
 * new senders. `live` = the campaign is sending now: the choice is applied at once, from now on.
 */
export function ThrottleBox({ data, remaining, live, onChange }: { data: any; remaining: number; live?: boolean; onChange: (speed: number | null) => void }) {
  const t = useT('campaigns');
  const th = data.throttle;
  const speed: number | null = data.speed_per_hour ?? null;
  const preset = speed === null ? '' : SPEEDS.includes(speed) ? String(speed) : 'custom';
  const [custom, setCustom] = useState(speed && !SPEEDS.includes(speed) ? String(speed) : '');
  const [mode, setMode] = useState<string>(preset);
  if (!th) return null;
  const perHour = speed ?? th.per_hour;
  const invalid = mode === 'custom' && Number.isNaN(speedValue(custom));
  const pick = (v: string) => {
    setMode(v);
    if (v === 'custom') return;
    onChange(v === '' ? null : Number(v));
  };
  return (
    <div className="qw-box" data-tour="campaign-speed">
      <h3>{t('Versandgeschwindigkeit')}</h3>
      <Field label={t('Nachrichten pro Stunde')}>
        <Select value={mode} onChange={pick} options={[['', t('Standard (ca. {n} pro Stunde)', { n: de(th.default_per_hour) })], ...SPEEDS.map((s) => [String(s), s <= 100 ? t('{n} pro Stunde – zum Aufwärmen', { n: de(s) }) : t('{n} pro Stunde', { n: de(s) })] as [string, string]), ['custom', t('Eigener Wert …')]]} />
      </Field>
      {mode === 'custom' && (
        <Field label={t('Eigener Wert (10 bis 50.000 pro Stunde)')} hint={invalid ? t('Bitte eine ganze Zahl zwischen 10 und 50.000 eingeben.') : undefined}>
          <Input
            type="number"
            min={10}
            max={50000}
            value={custom}
            onChange={(v) => {
              setCustom(v);
              const n = speedValue(v);
              if (!Number.isNaN(n) && n !== null) onChange(n);
            }}
          />
        </Field>
      )}
      <p className="small" style={{ margin: '4px 0' }}>
        {remaining > 0 ? etaText(remaining, perHour) : live ? t('Nichts mehr zu senden.') : t('Sobald Empfänger feststehen, steht hier die Dauer.')}
        {live && th.eta_minutes !== null && <span className="muted"> {t('(jetzt noch {n} offen, {duration})', { n: de(remaining), duration: durationText(th.eta_minutes) })}</span>}
      </p>
      <p className="muted small" style={{ margin: '4px 0' }}>
        {speed ? t('Entspricht etwa {n} Nachrichten alle {s} Sekunden.', { n: de(th.batch_per_tick), s: th.tick_seconds }) : t('Standard: {n} Nachrichten alle {s} Sekunden (Einstellung des Sub-Accounts).', { n: de(th.batch_per_tick), s: th.tick_seconds })}{' '}
        {t('Die Zeit ist eine Schätzung – langsame Mailserver oder Fehler verlängern sie.')}
      </p>
      {data.warmup?.advice && (
        <p className={`qw-hint ${data.warmup.level === 'warn' && perHour > data.warmup.recommended_per_hour ? 'warn' : ''}`} role="note">
          {data.warmup.advice}
        </p>
      )}
    </div>
  );
}
