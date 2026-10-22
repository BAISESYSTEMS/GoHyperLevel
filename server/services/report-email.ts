import { escapeHtml } from '../core/template.js';
import { addDaysYmd, ymdInTz, zonedToUtc } from '../core/time.js';
import { deltaPercent, formatValue, lowerIsBetter, type Format, type ReportResult } from './report-engine.js';

/** Scheduled report e-mails: when they run next and the HTML/text they send (tables, no images). */

export type Frequency = 'daily' | 'weekly' | 'monthly';
export const FREQUENCIES: Record<Frequency, string> = { daily: 'Täglich', weekly: 'Wöchentlich', monthly: 'Monatlich' };
/** The period a schedule reports on by default. */
export const DEFAULT_SCHEDULE_RANGE: Record<Frequency, string> = { daily: 'yesterday', weekly: 'last_week', monthly: 'last_month' };

export interface ScheduleTiming {
  frequency: Frequency;
  /** 1 = Monday … 7 = Sunday (weekly). */
  weekday: number;
  /** 1–28 (monthly). */
  monthday: number;
  hour: number;
}

/** Next send time after `after` at `hour`:00 local time in `tz`. */
export function nextRun(s: ScheduleTiming, tz: string, after: Date): Date {
  let day = ymdInTz(after, tz);
  for (let i = 0; i < 70; i++, day = addDaysYmd(day, 1)) {
    const [y, m, d] = day.split('-').map(Number);
    const dow = ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
    if (s.frequency === 'weekly' && dow !== s.weekday) continue;
    if (s.frequency === 'monthly' && d !== s.monthday) continue;
    const at = zonedToUtc(day, `${String(s.hour).padStart(2, '0')}:00`, tz);
    if (at.getTime() > after.getTime()) return at;
  }
  return new Date(after.getTime() + 864e5);
}

export interface EmailWidget {
  title: string;
  viz: string;
  result?: ReportResult;
  error?: string;
}

const C = { ink: '#111827', muted: '#6b7280', line: '#e5e7eb', bar: '#2a78d6', up: '#047857', down: '#b91c1c', bg: '#f4f6fa' };
const pct = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
const signed = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1, signDisplay: 'exceptZero' });

/** "▲ 12,5 % ggü. Vorperiode" – arrow = direction, colour = good/bad for this measure. */
function deltaHtml(key: string, cur: number | null | undefined, prev: number | null | undefined, format: Format): string {
  const tone = (up: boolean) => (up !== lowerIsBetter(key) ? C.up : C.down);
  if (format === 'percent' && cur !== null && cur !== undefined && prev !== null && prev !== undefined) {
    const diff = cur - prev;
    return `<span style="color:${tone(diff >= 0)};font-size:13px">${diff >= 0 ? '▲' : '▼'} ${pct.format(Math.abs(diff))} Pkt. ggü. Vorperiode</span>`;
  }
  const d = deltaPercent(cur, prev);
  if (d === null) return prev !== undefined ? `<span style="color:${C.muted};font-size:13px">Vorperiode: ${escapeHtml(formatValue(prev ?? null, format))}</span>` : '';
  return `<span style="color:${tone(d >= 0)};font-size:13px">${d >= 0 ? '▲' : '▼'} ${pct.format(Math.abs(d))} % ggü. Vorperiode</span>`;
}

function kpiHtml(w: EmailWidget, r: ReportResult): string {
  const m = r.measures[0];
  return `<td style="padding:12px;border:1px solid ${C.line};border-radius:8px;vertical-align:top;width:50%">
    <div style="color:${C.muted};font-size:13px">${escapeHtml(w.title)}</div>
    <div style="font-size:26px;font-weight:700;color:${C.ink};margin:4px 0">${escapeHtml(formatValue(r.totals.v[0], m.format))}</div>
    ${r.totals.p ? deltaHtml(m.key, r.totals.v[0], r.totals.p[0], m.format) : ''}
  </td>`;
}

/** A chart as a table: label, a bar drawn with a cell width, the value. */
function tableHtml(w: EmailWidget, r: ReportResult): string {
  const m = r.measures[0];
  let rows = r.rows.map((row) => ({ label: row.l.filter(Boolean).join(' · ') || 'Gesamt', v: row.v[0] ?? 0, rest: row.v.slice(1) }));
  if (r.dims[0]?.type === 'date' && r.dims.length === 1) rows = rows.slice(-12);
  else rows = rows.slice(0, 10);
  const max = Math.max(1e-9, ...rows.map((x) => Math.abs(x.v)));
  const extra = r.measures.slice(1, 3);
  const body = rows
    .map((x) => {
      const width = Math.max(1, Math.round((Math.abs(x.v) / max) * 100));
      return `<tr>
        <td style="padding:5px 8px 5px 0;color:${C.ink};font-size:13px;border-bottom:1px solid ${C.line}">${escapeHtml(x.label)}</td>
        <td style="padding:5px 8px;width:40%;border-bottom:1px solid ${C.line}"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td style="background:${C.bar};height:10px;width:${width}%;border-radius:0 4px 4px 0;font-size:0;line-height:0">&nbsp;</td><td style="font-size:0;line-height:0">&nbsp;</td></tr></table></td>
        <td style="padding:5px 0;text-align:right;color:${C.ink};font-size:13px;white-space:nowrap;border-bottom:1px solid ${C.line}">${escapeHtml(formatValue(x.v, m.format))}</td>
        ${extra.map((e, i) => `<td style="padding:5px 0 5px 10px;text-align:right;color:${C.muted};font-size:13px;white-space:nowrap;border-bottom:1px solid ${C.line}">${escapeHtml(formatValue(x.rest[i] ?? null, e.format))}</td>`).join('')}
      </tr>`;
    })
    .join('');
  const head = `<tr><th style="text-align:left;color:${C.muted};font-size:12px;font-weight:600;padding:0 8px 4px 0">${escapeHtml(r.dims.map((d) => d.label).join(' · '))}</th><th></th><th style="text-align:right;color:${C.muted};font-size:12px;font-weight:600;padding:0 0 4px">${escapeHtml(m.label)}</th>${extra.map((e) => `<th style="text-align:right;color:${C.muted};font-size:12px;font-weight:600;padding:0 0 4px 10px">${escapeHtml(e.label)}</th>`).join('')}</tr>`;
  return `<div style="margin:18px 0 6px;font-weight:700;font-size:15px;color:${C.ink}">${escapeHtml(w.title)}</div>
    ${rows.length ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse">${head}${body}</table>` : `<div style="color:${C.muted};font-size:13px">Keine Daten im Zeitraum.</div>`}
    ${r.dims.length && r.rows.length > rows.length ? `<div style="color:${C.muted};font-size:12px;margin-top:4px">… ${r.rows.length - rows.length} weitere Zeilen im Dashboard</div>` : ''}`;
}

export function renderReportEmail(input: { title: string; rangeLabel: string; link: string; brand: string; widgets: EmailWidget[] }): { html: string; text: string } {
  const kpis = input.widgets.filter((w) => w.result && (w.viz === 'kpi' || !w.result.dims.length));
  const charts = input.widgets.filter((w) => !kpis.includes(w));
  const kpiRows: string[] = [];
  for (let i = 0; i < kpis.length; i += 2) kpiRows.push(`<tr>${kpis.slice(i, i + 2).map((w) => kpiHtml(w, w.result!)).join('<td style="width:10px"></td>')}</tr><tr><td style="height:10px"></td></tr>`);
  const chartHtml = charts.map((w) => (w.result ? tableHtml(w, w.result) : `<div style="margin:18px 0 6px;font-weight:700;font-size:15px">${escapeHtml(w.title)}</div><div style="color:${C.down};font-size:13px">${escapeHtml(w.error ?? 'Fehler')}</div>`)).join('');
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(input.title)}</title></head>
<body style="margin:0;background:${C.bg};font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:${C.ink}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:12px;border:1px solid ${C.line}"><tr><td style="padding:24px">
  <div style="color:${C.muted};font-size:12px;text-transform:uppercase;letter-spacing:.05em">${escapeHtml(input.brand)} · Bericht</div>
  <h1 style="font-size:22px;margin:4px 0 2px">${escapeHtml(input.title)}</h1>
  <div style="color:${C.muted};font-size:13px;margin-bottom:16px">${escapeHtml(input.rangeLabel)}</div>
  ${kpiRows.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate">${kpiRows.join('')}</table>` : ''}
  ${chartHtml}
  <div style="margin-top:24px"><a href="${escapeHtml(input.link)}" style="display:inline-block;background:${C.bar};color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">Im Dashboard ansehen</a></div>
</td></tr></table>
<div style="color:${C.muted};font-size:12px;margin-top:12px">Du bekommst diese E-Mail, weil sie unter Berichte → Zeitpläne eingerichtet ist.</div>
</td></tr></table></body></html>`;
  const lines = [`${input.title} – ${input.rangeLabel}`, ''];
  for (const w of input.widgets) {
    if (!w.result) {
      lines.push(`${w.title}: ${w.error ?? 'Fehler'}`);
      continue;
    }
    const r = w.result;
    if (w.viz === 'kpi' || !r.dims.length) {
      const d = r.totals.p ? deltaPercent(r.totals.v[0], r.totals.p[0]) : null;
      lines.push(`${w.title}: ${formatValue(r.totals.v[0], r.measures[0].format)}${d !== null ? ` (${signed.format(d)} % ggü. Vorperiode)` : ''}`);
    } else {
      lines.push(`${w.title}:`);
      for (const row of r.rows.slice(0, 10)) lines.push(`  ${row.l.filter(Boolean).join(' · ')}: ${formatValue(row.v[0], r.measures[0].format)}`);
    }
    lines.push('');
  }
  lines.push(`Im Dashboard ansehen: ${input.link}`);
  return { html, text: lines.join('\n') };
}
