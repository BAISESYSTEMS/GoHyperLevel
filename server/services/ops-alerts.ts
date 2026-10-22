import { statfsSync } from 'node:fs';

/**
 * Health checks and alert formatting for operations (modules/ops-alerts.ts, docs/backups.md#uptime-and-alerts). Pure apart
 * from `diskFree` (statfs of the data folder).
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'off';
export interface Check {
  status: CheckStatus;
  /** Short German text for the admin panel and the alert. */
  detail: string;
  value?: number;
}
export interface HealthReport {
  status: 'ok' | 'degraded' | 'fail';
  at: string;
  checks: { db: Check; disk: Check; tick: Check; backup: Check };
}

/** Free space of the file system that holds `dir`, in percent and bytes; undefined where statfs is not available. */
export function diskFree(dir: string): { percent: number; free: number; total: number } | undefined {
  try {
    const s = statfsSync(dir);
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    if (!total) return undefined;
    return { percent: Math.round((free / total) * 1000) / 10, free, total };
  } catch {
    return undefined;
  }
}

/** Below 10 % free the disk check fails (alert), below 20 % it warns. */
export const DISK_FAIL_PERCENT = 10;
export const DISK_WARN_PERCENT = 20;

export function diskCheck(free: { percent: number; free: number } | undefined): Check {
  if (!free) return { status: 'off', detail: 'Freier Speicher nicht messbar' };
  const gb = (free.free / 1024 ** 3).toFixed(1).replace('.', ',');
  const pct = String(free.percent).replace('.', ',');
  if (free.percent < DISK_FAIL_PERCENT) return { status: 'fail', detail: `Nur noch ${pct} % frei (${gb} GB)`, value: free.percent };
  if (free.percent < DISK_WARN_PERCENT) return { status: 'warn', detail: `${pct} % frei (${gb} GB)`, value: free.percent };
  return { status: 'ok', detail: `${pct} % frei (${gb} GB)`, value: free.percent };
}

/** The scheduler counts as stalled when its last round is longer ago than ten ticks and at least five minutes. */
export function tickCheck(lastTickAt: number | undefined, startedAt: number, tickMs: number, at: number): Check {
  if (tickMs <= 0) return { status: 'off', detail: 'Hintergrund-Aufgaben abgeschaltet (PGHL_TICK_MS=0)' };
  const limit = Math.max(5 * 60_000, tickMs * 10);
  const since = lastTickAt ?? startedAt;
  const lag = Math.max(0, at - since);
  const secs = Math.round(lag / 1000);
  if (lag > limit) return { status: 'fail', detail: lastTickAt ? `Letzte Runde vor ${Math.round(secs / 60)} min – die Hintergrund-Aufgaben hängen` : 'Noch keine Runde der Hintergrund-Aufgaben seit dem Start', value: secs };
  return { status: 'ok', detail: lastTickAt ? `Letzte Runde vor ${secs} s` : 'Startet gerade', value: secs };
}

/** Backup age: off-site (if set up) may be 2 h old, the local daily snapshot 26 h; a fresh process gets that much grace. */
export function backupCheck(b: { source: 'offsite' | 'local' | 'none'; at?: string; maxMinutes: number }, startedAt: number, at: number): Check {
  if (b.source === 'none') return { status: 'off', detail: 'Keine Backups eingerichtet' };
  const label = b.source === 'offsite' ? 'Off-site-Backup' : 'Lokales Backup';
  if (!b.at) {
    if (at - startedAt < b.maxMinutes * 60_000) return { status: 'ok', detail: `${label}: das erste läuft bald` };
    return { status: 'fail', detail: `${label}: noch keins erfolgreich` };
  }
  const min = Math.round((at - Date.parse(b.at)) / 60_000);
  const age = min >= 120 ? `${Math.round(min / 60)} h` : `${min} min`;
  if (min > b.maxMinutes) return { status: 'fail', detail: `${label} ist ${age} alt (erlaubt ${Math.round(b.maxMinutes / 60)} h)`, value: min };
  return { status: 'ok', detail: `${label} vor ${age}`, value: min };
}

/** Overall: any failing check → fail when it is the database, else degraded. */
export function overall(checks: HealthReport['checks']): HealthReport['status'] {
  if (checks.db.status === 'fail') return 'fail';
  return Object.values(checks).some((c) => c.status === 'fail') ? 'degraded' : 'ok';
}

/** Unexpected server errors in a sliding window, to spot a spike. */
export class ErrorWindow {
  private hits: number[] = [];
  constructor(private windowMs = 5 * 60_000) {}
  add(at = Date.now()) {
    this.hits.push(at);
    if (this.hits.length > 10_000) this.hits = this.hits.slice(-5000);
  }
  count(at = Date.now()) {
    this.hits = this.hits.filter((t) => at - t < this.windowMs);
    return this.hits.length;
  }
}

/** An error-rate spike: at least this many unexpected errors in five minutes, and at least 5 % of the requests. */
export const SPIKE_ERRORS = 20;
export const SPIKE_SHARE = 0.05;
export const isSpike = (errors: number, requests: number) => errors >= SPIKE_ERRORS && errors >= Math.max(1, requests) * SPIKE_SHARE;

export interface Alert {
  key: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  body: string;
  /** true: the problem is over. */
  resolved?: boolean;
}

/**
 * The request for the optional webhook (PGHL_ALERT_WEBHOOK): ntfy (topic URL), Slack and Discord (incoming webhooks), Telegram
 * (https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>) – recognised by the address –, anything else gets JSON.
 */
export function webhookRequest(url: string, a: Alert, brand: string): { url: string; init: { method: string; headers: Record<string, string>; body: string } } {
  const u = new URL(url);
  const title = `${a.resolved ? '✅' : a.severity === 'critical' ? '🔴' : a.severity === 'warning' ? '🟠' : 'ℹ️'} ${brand}: ${a.title}`;
  const textBody = `${title}\n${a.body}`;
  if (/(^|\.)ntfy\.sh$/.test(u.hostname) || /\bntfy\b/.test(u.hostname)) {
    return {
      url,
      init: {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8', title: encodeHeader(title), priority: a.resolved ? '3' : a.severity === 'critical' ? '5' : '4', tags: a.resolved ? 'white_check_mark' : 'warning' },
        body: a.body,
      },
    };
  }
  if (u.hostname === 'hooks.slack.com') return { url, init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: textBody }) } };
  if (/(^|\.)discord(app)?\.com$/.test(u.hostname)) return { url, init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: textBody.slice(0, 1900) }) } };
  if (u.hostname === 'api.telegram.org') {
    const chat = u.searchParams.get('chat_id') ?? '';
    u.searchParams.delete('chat_id');
    return { url: u.toString(), init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: textBody.slice(0, 4000) }) } };
  }
  return { url, init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: brand, key: a.key, severity: a.severity, title: a.title, body: a.body, resolved: !!a.resolved, at: new Date().toISOString() }) } };
}

/** HTTP header values are Latin-1: other characters (emoji, umlauts) go RFC 2047-encoded, which ntfy understands. */
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
