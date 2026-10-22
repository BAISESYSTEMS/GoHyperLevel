import { useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { Badge, Select } from '../ui';
import './marketing.css';
import { SOURCE_LOCALE } from '../i18n/registry';
import { getLocale, intlLocale, useT } from '../i18n';

/** Small helpers shared by the e-mail marketing pages (segments, gallery, deliverability, campaign extras). Numbers follow the UI language. */

export const de = (n: number | null | undefined, digits = 0) => (Number(n) || 0).toLocaleString(intlLocale(), { maximumFractionDigits: digits });

/** "23,4 %" in German, "23.4%" in English. */
const percent = (text: string) => (getLocale() === SOURCE_LOCALE ? `${text} %` : `${text}%`);

/** A rate as a fraction (0.0234) → "2,34 %". */
export const pct = (rate: number | null | undefined, digits = 2) => percent(((Number(rate) || 0) * 100).toLocaleString(intlLocale(), { maximumFractionDigits: digits }));

/** A percentage that is already in percent (23.4) → "23,4 %". */
export const pctPlain = (v: number | null | undefined, digits = 1) => percent((Number(v) || 0).toLocaleString(intlLocale(), { maximumFractionDigits: digits }));

export const euro = (cents: number | null | undefined) => ((Number(cents) || 0) / 100).toLocaleString(intlLocale(), { style: 'currency', currency: 'EUR' });

export const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;

type Tone = 'green' | 'yellow' | 'red' | 'gray';
/** German labels (message ids of the campaigns catalog), shown through t(). */
export const LEVEL: Record<string, [string, Tone]> = { ok: ['in Ordnung', 'green'], few: ['zu wenig Daten', 'gray'], warn: ['Warnung', 'yellow'], critical: ['kritisch', 'red'] };

export function LevelBadge({ level }: { level: string }) {
  const t = useT('campaigns');
  const [label, tone] = LEVEL[level] ?? [level, 'gray'];
  return <Badge tone={tone}>{LEVEL[level] ? t(label) : label}</Badge>;
}

/** The value, delayed by `ms` after the last change (live counts while somebody is still typing). */
export function useDebounced<T>(value: T, ms = 450): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** A rate with its thresholds as a small bar: green below the warning, yellow from it, red from the critical value. */
export function RateBar({ label, rate, warn, critical }: { label: string; rate: number; warn: number; critical: number }) {
  const t = useT('campaigns');
  const level = rate >= critical ? 'critical' : rate >= warn ? 'warn' : 'ok';
  // The bar ends at twice the critical value, so the thresholds sit in the left half where the numbers usually are.
  const width = Math.min(100, (rate / (critical * 2)) * 100);
  return (
    <div className={`mk-rate ${level}`} title={t('Warnung ab {warn}, kritisch ab {critical}', { warn: pct(warn), critical: pct(critical) })}>
      <div className="t">
        <span>{label}</span>
        <strong>{pct(rate)}</strong>
      </div>
      <div className="track" role="img" aria-label={`${label} ${pct(rate)}`}>
        <div className="fill" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

export function Kpi({ label, value, tone, sub }: { label: string; value: ReactNode; tone?: string; sub?: ReactNode }) {
  return (
    <div className={`mk-kpi ${tone ?? ''}`}>
      <div className="v">{value}</div>
      <div className="l">{label}</div>
      {sub && <div className="l">{sub}</div>}
    </div>
  );
}

/** The shared Select with a `disabled` switch (a disabled fieldset disables everything inside it). */
export function Sel({ disabled, ...p }: ComponentProps<typeof Select> & { disabled?: boolean }) {
  return disabled ? (
    <fieldset disabled className="mk-fs">
      <Select {...p} />
    </fieldset>
  ) : (
    <Select {...p} />
  );
}
