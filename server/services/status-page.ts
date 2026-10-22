import { escapeHtml as h } from '../core/template.js';

/**
 * The public status page (/status, modules/status-page.ts): uptime per component and day from the instance's own health
 * samples (one per 5 minutes; a missing sample counts as down – the server could not even write it), and the incidents the
 * operator writes. Pure: numbers in, HTML out. Server-rendered, no script, no cookie, no outside resource.
 */

export const BUCKET_MS = 5 * 60_000;
export const DAYS = 90;
export type Source = 'app' | 'jobs' | 'backup';
export const COMPONENTS: { key: string; name: string; source: Source }[] = [
  { key: 'app', name: 'Web-App & API', source: 'app' },
  { key: 'sites', name: 'Websites, Formulare & Buchungsseiten', source: 'app' },
  { key: 'jobs', name: 'Automationen & Versand', source: 'jobs' },
  { key: 'backup', name: 'Datensicherung', source: 'backup' },
];
export const IMPACT_LABEL: Record<string, string> = { minor: 'Eingeschränkt', major: 'Störung', maintenance: 'Wartung' };
export const STATUS_LABEL: Record<string, string> = { investigating: 'Wird untersucht', identified: 'Ursache gefunden', monitoring: 'Wird beobachtet', resolved: 'Behoben' };

export interface Sample {
  bucket: number;
  app: number;
  jobs: number;
  backup: number;
}
export interface Incident {
  id: string;
  title: string;
  impact: string;
  components: string[];
  status: string;
  started_at: string;
  resolved_at: string | null;
  updates: { status: string; body: string; at: string }[];
}

export const bucketOf = (t: number) => Math.floor(t / BUCKET_MS);
const dayStart = (t: number) => Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate());

/**
 * Uptime per source and UTC day for the last `days` days (oldest first): ok samples ÷ expected samples, where expected counts the
 * 5-minute slots since the first sample ever and up to the last finished slot. null = no data for that day.
 */
export function dailyUptime(samples: Sample[], o: { now: number; first?: number; days?: number }): { days: string[]; uptime: Record<Source, (number | null)[]>; total: Record<Source, number | null> } {
  const days = o.days ?? DAYS;
  const first = o.first ?? (samples.length ? Math.min(...samples.map((s) => s.bucket)) : undefined);
  const lastDone = bucketOf(o.now) - 1;
  const today = dayStart(o.now);
  const labels: string[] = [];
  const ok: Record<Source, number[]> = { app: [], jobs: [], backup: [] };
  const expected: number[] = [];
  for (let i = 0; i < days; i++) {
    const start = today - (days - 1 - i) * 864e5;
    labels.push(new Date(start).toISOString().slice(0, 10));
    const a = Math.max(bucketOf(start), first ?? Infinity);
    const b = Math.min(bucketOf(start + 864e5) - 1, lastDone);
    expected.push(first === undefined ? 0 : Math.max(0, b - a + 1));
    for (const k of Object.keys(ok) as Source[]) ok[k].push(0);
  }
  const firstDayBucket = bucketOf(today - (days - 1) * 864e5);
  for (const s of samples) {
    if (s.bucket < firstDayBucket || s.bucket > lastDone || (first !== undefined && s.bucket < first)) continue;
    const i = Math.floor((s.bucket * BUCKET_MS - (today - (days - 1) * 864e5)) / 864e5);
    if (i < 0 || i >= days) continue;
    for (const k of Object.keys(ok) as Source[]) if (s[k]) ok[k][i]++;
  }
  const uptime = {} as Record<Source, (number | null)[]>;
  const total = {} as Record<Source, number | null>;
  const allExpected = expected.reduce((x, y) => x + y, 0);
  for (const k of Object.keys(ok) as Source[]) {
    uptime[k] = expected.map((e, i) => (e ? Math.min(1, ok[k][i] / e) : null));
    total[k] = allExpected ? Math.min(1, ok[k].reduce((x, y) => x + y, 0) / allExpected) : null;
  }
  return { days: labels, uptime, total };
}

export type Current = 'ok' | 'degraded' | 'outage' | 'maintenance' | 'unknown';
export const CURRENT_LABEL: Record<Current, string> = { ok: 'In Betrieb', degraded: 'Eingeschränkt', outage: 'Störung', maintenance: 'Wartung', unknown: 'Keine Daten' };

/** Status of a component now: an open incident wins, else the newest sample (older than 15 minutes = no data). */
export function currentStatus(key: string, source: Source, latest: Sample | undefined, open: Incident[], now: number): Current {
  const mine = open.filter((i) => i.components.includes(key));
  if (mine.some((i) => i.impact === 'major')) return 'outage';
  if (mine.some((i) => i.impact === 'minor')) return 'degraded';
  if (mine.some((i) => i.impact === 'maintenance')) return 'maintenance';
  if (!latest || bucketOf(now) - latest.bucket > 3) return 'unknown';
  return latest[source] ? 'ok' : 'outage';
}

const pct = (v: number | null) => (v === null ? '–' : `${(Math.floor(v * 10000) / 100).toFixed(2).replace('.', ',')} %`);
const tone = (v: number | null) => (v === null ? 'none' : v >= 0.999 ? 'ok' : v >= 0.99 ? 'minor' : v >= 0.95 ? 'major' : 'down');
const de = (iso: string) => new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const day = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;

export function renderStatusPage(d: { brand: string; now: number; components: { key: string; name: string; current: Current; daily: (number | null)[]; total: number | null }[]; days: string[]; open: Incident[]; past: Incident[]; abuseUrl?: string }): string {
  const worst: Current = d.components.some((c) => c.current === 'outage') ? 'outage' : d.components.some((c) => c.current === 'degraded') ? 'degraded' : d.components.some((c) => c.current === 'maintenance') ? 'maintenance' : d.components.every((c) => c.current === 'unknown') ? 'unknown' : 'ok';
  const banner: Record<Current, string> = { ok: 'Alle Systeme in Betrieb', degraded: 'Einzelne Dienste eingeschränkt', outage: 'Störung', maintenance: 'Wartungsarbeiten', unknown: 'Noch keine Messwerte' };
  const incident = (i: Incident) => `<article class="inc ${h(i.impact)}"><h3>${h(i.title)} <span class="tag">${h(IMPACT_LABEL[i.impact] ?? i.impact)}</span></h3>
<p class="meta">${de(i.started_at)}${i.resolved_at ? ` – ${de(i.resolved_at)}` : ''} · ${h(STATUS_LABEL[i.status] ?? i.status)}${i.components.length ? ` · ${h(i.components.map((k) => COMPONENTS.find((c) => c.key === k)?.name ?? k).join(', '))}` : ''}</p>
${i.updates.map((u) => `<div class="upd"><strong>${h(STATUS_LABEL[u.status] ?? u.status)}</strong> <span class="meta">${de(u.at)}</span><p>${h(u.body).replace(/\n/g, '<br>')}</p></div>`).join('')}</article>`;
  const rows = d.components
    .map(
      (c) => `<section class="comp"><div class="head"><h2>${h(c.name)}</h2><span class="st ${c.current}">${CURRENT_LABEL[c.current]}</span></div>
<div class="bars" role="img" aria-label="${h(`${c.name}: ${pct(c.total)} Verfügbarkeit in ${d.days.length} Tagen`)}">${c.daily.map((v, i) => `<span class="b ${tone(v)}" title="${day(d.days[i])}: ${pct(v)}"></span>`).join('')}</div>
<div class="foot"><span>vor ${d.days.length} Tagen</span><span>${pct(c.total)} verfügbar</span><span>heute</span></div></section>`,
    )
    .join('');
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="60"><meta name="robots" content="noindex">
<title>Status – ${h(d.brand)}</title>
<style>
:root{--ok:#16a34a;--minor:#84cc16;--major:#f59e0b;--down:#dc2626;--none:#d1d5db;--maint:#2563eb;--text:#111827;--muted:#6b7280;--line:#e5e7eb;--bg:#f9fafb;--card:#fff}
@media (prefers-color-scheme:dark){:root{--text:#f3f4f6;--muted:#9ca3af;--line:#374151;--bg:#111827;--card:#1f2937;--none:#4b5563}}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.5}
.wrap{max-width:860px;margin:0 auto;padding:32px 16px}h1{font-size:24px;margin:0 0 16px}h2{font-size:16px;margin:0}h3{font-size:16px;margin:0 0 4px}
.banner{border-radius:12px;padding:16px 18px;font-weight:600;color:#fff;margin-bottom:22px}.banner.ok{background:var(--ok)}.banner.degraded{background:var(--major)}.banner.outage{background:var(--down)}.banner.maintenance{background:var(--maint)}.banner.unknown{background:var(--muted)}
.comp,.inc{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:12px}
.head{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
.st{font-size:13px;font-weight:600}.st.ok{color:var(--ok)}.st.degraded{color:var(--major)}.st.outage{color:var(--down)}.st.maintenance{color:var(--maint)}.st.unknown{color:var(--muted)}
.bars{display:flex;gap:2px;height:32px}.b{flex:1;border-radius:2px;min-width:1px}.b.ok{background:var(--ok)}.b.minor{background:var(--minor)}.b.major{background:var(--major)}.b.down{background:var(--down)}.b.none{background:var(--none)}
.foot{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-top:6px;gap:8px}
.meta{color:var(--muted);font-size:13px;margin:0}.tag{font-size:12px;font-weight:600;border:1px solid var(--line);border-radius:99px;padding:1px 8px;margin-left:6px}
.inc.major{border-left:4px solid var(--down)}.inc.minor{border-left:4px solid var(--major)}.inc.maintenance{border-left:4px solid var(--maint)}
.upd{border-top:1px solid var(--line);padding-top:8px;margin-top:8px}.upd p{margin:4px 0 0}
footer{color:var(--muted);font-size:13px;margin-top:28px}a{color:inherit}
</style></head><body><main class="wrap">
<h1>Status – ${h(d.brand)}</h1>
<div class="banner ${worst}" role="status">${banner[worst]}</div>
${d.open.length ? `<h2 style="margin:0 0 10px">Aktuelle Vorfälle</h2>${d.open.map(incident).join('')}` : ''}
${rows}
<h2 style="margin:26px 0 10px">Vorfälle der letzten ${d.days.length} Tage</h2>
${d.past.length ? d.past.map(incident).join('') : '<p class="meta">Keine Vorfälle.</p>'}
<footer>Gemessen von dieser Instanz selbst alle 5 Minuten; fehlt eine Messung, zählt der Zeitraum als Ausfall. Tage in UTC. Stand ${de(new Date(d.now).toISOString())}.${d.abuseUrl ? ` · <a href="${h(d.abuseUrl)}">Missbrauch melden</a>` : ''}</footer>
</main></body></html>`;
}
