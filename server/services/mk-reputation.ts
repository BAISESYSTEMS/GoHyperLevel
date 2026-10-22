import type { App } from '../core/app.js';

/**
 * Sender reputation of a sub-account: bounce, complaint (spam) and unsubscribe rates of the campaign e-mails per campaign,
 * per recipient domain (Gmail, GMX, …) and per week, judged against the limits mailbox providers apply. Pure judging in
 * `judge`, the numbers come from `buildReport` (messages of campaigns, the activity log for unsubscribes).
 */

export interface Counts {
  sent: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  opened: number;
  clicked: number;
}
export type Level = 'ok' | 'warn' | 'critical' | 'few';
export type Metric = 'bounce' | 'complaint' | 'unsubscribe';

/** Rates (0..1) from which a metric warns or is critical. Gmail/Yahoo/Microsoft ask for complaints below 0.3 % (aim for 0.1 %). */
export const THRESHOLDS: Record<Metric, { warn: number; critical: number; label: string }> = {
  bounce: { warn: 0.02, critical: 0.05, label: 'Bounce-Rate' },
  complaint: { warn: 0.001, critical: 0.003, label: 'Spam-Beschwerden' },
  unsubscribe: { warn: 0.005, critical: 0.01, label: 'Abmelderate' },
};
/** Below this many sent mails a rate says little; the level is "few" (unless complaints already pile up). */
export const MIN_SAMPLE = 100;

const TIPS: Record<Metric, string> = {
  bounce: 'Zu viele Adressen sind unzustellbar. Adressen prüfen (Zustellbarkeit → Adressprüfung), alte oder gekaufte Listen nicht verwenden und Kontakte mit wiederholten Soft Bounces ausschließen.',
  complaint: 'Zu viele Empfänger markieren die Mail als Spam. Nur an Kontakte mit Einwilligung senden, den Abmeldelink gut sichtbar halten, seltener und relevanter schreiben.',
  unsubscribe: 'Viele melden sich ab. Betreff und Inhalt auf die Erwartung der Empfänger abstimmen, die Häufigkeit senken oder die Liste in Segmente teilen.',
};

export interface Rates {
  bounce: number;
  complaint: number;
  unsubscribe: number;
  open: number;
  click: number;
}

const ratio = (n: number, d: number) => (d > 0 ? n / d : 0);

export function rates(c: Counts): Rates {
  return { bounce: ratio(c.bounced, c.sent), complaint: ratio(c.complained, c.sent), unsubscribe: ratio(c.unsubscribed, c.sent), open: ratio(c.opened, c.sent), click: ratio(c.clicked, c.sent) };
}

export interface Issue {
  metric: Metric;
  level: 'warn' | 'critical';
  rate: number;
  text: string;
  tip: string;
}

const pct = (r: number) => `${(Math.round(r * 10_000) / 100).toLocaleString('de-DE')} %`;

/** The verdict for some counts: ok, warn or critical (or "few" when there is too little data to say). */
export function judge(c: Counts): { level: Level; issues: Issue[]; rates: Rates } {
  const r = rates(c);
  const few = c.sent < MIN_SAMPLE;
  const issues: Issue[] = [];
  for (const m of Object.keys(THRESHOLDS) as Metric[]) {
    const t = THRESHOLDS[m];
    const rate = r[m];
    // With little data a single complaint is already 1 % – only when several pile up is it worth a warning.
    if (few && !(m === 'complaint' && c.complained >= 2)) continue;
    const level = rate >= t.critical ? 'critical' : rate >= t.warn ? 'warn' : null;
    if (!level) continue;
    const limit = level === 'critical' ? t.critical : t.warn;
    issues.push({ metric: m, level, rate, text: `${t.label} ${pct(rate)} (${level === 'critical' ? 'kritisch ab' : 'Warnung ab'} ${pct(limit)})`, tip: TIPS[m] });
  }
  const level: Level = issues.some((i) => i.level === 'critical') ? 'critical' : issues.length ? 'warn' : few ? 'few' : 'ok';
  return { level, issues, rates: r };
}

const ORDER: Record<Level, number> = { ok: 0, few: 1, warn: 2, critical: 3 };
export const worse = (a: Level, b: Level): Level => (ORDER[a] >= ORDER[b] ? a : b);

export const LEVEL_LABEL: Record<Level, string> = { ok: 'in Ordnung', few: 'zu wenig Daten', warn: 'Warnung', critical: 'kritisch' };

// --- the numbers from the database ----------------------------------------------------------------------

/** Statuses of mails that left the system (a failed mail never arrived anywhere, so it says nothing about the sender). */
const SENT = `('sent', 'delivered', 'bounced', 'complained')`;

export interface Row extends Counts {
  key: string;
  label: string;
  level: Level;
  issues: Issue[];
  rates: Rates;
}

export interface Report {
  days: number;
  since: string;
  sending_domain: string;
  totals: Row;
  by_campaign: (Row & { campaign_id: string; sent_at: string | null })[];
  by_domain: Row[];
  by_week: (Row & { from: string })[];
  warnings: { level: 'warn' | 'critical'; scope: string; text: string; tip: string }[];
}

const sum = (v: unknown) => Number(v) || 0;
const zero = (): Counts => ({ sent: 0, bounced: 0, complained: 0, unsubscribed: 0, opened: 0, clicked: 0 });
const row = (key: string, label: string, c: Counts): Row => ({ key, label, ...c, ...judge(c) });
const weekKey = (iso: string) => {
  // Same grouping as SQLite's strftime('%Y-%W') so the unsubscribes land in the weeks of the mails.
  const d = new Date(iso);
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - jan1) / 864e5);
  const wd = (d.getUTCDay() + 6) % 7; // Monday = 0
  const week = Math.floor((dayOfYear + 7 - wd) / 7);
  return `${d.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
};

/** How long after a mail an unsubscribe still counts for that mail. */
const UNSUB_WINDOW_MS = 7 * 864e5;

export function buildReport(app: App, locationId: string, opts: { days?: number } = {}): Report {
  const { db } = app;
  const days = Math.min(365, Math.max(7, Math.floor(opts.days ?? 90)));
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const base = `FROM campaign_recipients r JOIN campaigns k ON k.id = r.campaign_id JOIN messages m ON m.id = r.message_id JOIN contacts c ON c.id = m.contact_id
     WHERE k.location_id = ? AND k.channel = 'email' AND m.channel = 'email' AND m.status IN ${SENT} AND m.created_at >= ?`;
  const cols = `COUNT(*) sent, SUM(m.status = 'bounced') bounced, SUM(m.status = 'complained') complained, SUM(m.opened_at IS NOT NULL) opened, SUM(m.clicked_at IS NOT NULL) clicked`;
  const counts = (r: any): Counts => ({ sent: sum(r.sent), bounced: sum(r.bounced), complained: sum(r.complained), unsubscribed: 0, opened: sum(r.opened), clicked: sum(r.clicked) });

  const campaigns = new Map<string, { name: string; sent_at: string | null; c: Counts }>();
  for (const r of db.all(`SELECT r.campaign_id id, k.name name, k.sent_at sent_at, ${cols} ${base} GROUP BY r.campaign_id`, locationId, since)) campaigns.set(r.id, { name: r.name, sent_at: r.sent_at, c: counts(r) });
  const domains = new Map<string, Counts>();
  for (const r of db.all(`SELECT lower(substr(c.email, instr(c.email, '@') + 1)) d, ${cols} ${base} GROUP BY d`, locationId, since)) domains.set(String(r.d || '(ohne)'), counts(r));
  const weeks = new Map<string, { from: string; c: Counts }>();
  for (const r of db.all(`SELECT strftime('%Y-%W', m.created_at) w, MIN(substr(m.created_at, 1, 10)) f, ${cols} ${base} GROUP BY w`, locationId, since)) weeks.set(String(r.w), { from: String(r.f), c: counts(r) });

  // Unsubscribes (the link carries no message): each one counts for the last campaign mail the contact got in the 7 days before.
  const unsubs = db.all<{ contact_id: string; created_at: string }>(`SELECT contact_id, created_at FROM activities WHERE location_id = ? AND type = 'contact.unsubscribed' AND contact_id IS NOT NULL AND created_at >= ?`, locationId, since);
  for (const u of unsubs) {
    const m = db.get<{ campaign_id: string; created_at: string; email: string }>(
      `SELECT r.campaign_id, m.created_at, c.email FROM campaign_recipients r JOIN campaigns k ON k.id = r.campaign_id JOIN messages m ON m.id = r.message_id JOIN contacts c ON c.id = m.contact_id
       WHERE k.location_id = ? AND m.contact_id = ? AND m.channel = 'email' AND m.created_at <= ? AND m.created_at >= ? ORDER BY m.created_at DESC LIMIT 1`,
      locationId,
      u.contact_id,
      u.created_at,
      new Date(Date.parse(u.created_at) - UNSUB_WINDOW_MS).toISOString(),
    );
    if (!m) continue;
    const camp = campaigns.get(m.campaign_id);
    if (camp) camp.c.unsubscribed++;
    const dom = domains.get(String(m.email.split('@')[1] ?? '').toLowerCase() || '(ohne)');
    if (dom) dom.unsubscribed++;
    const wk = weeks.get(weekKey(m.created_at));
    if (wk) wk.c.unsubscribed++;
  }

  const total = zero();
  for (const { c } of campaigns.values()) for (const k of Object.keys(total) as (keyof Counts)[]) total[k] += c[k];
  const by_campaign = [...campaigns.entries()]
    .map(([id, v]) => ({ campaign_id: id, sent_at: v.sent_at, ...row(id, v.name, v.c) }))
    .sort((a, b) => String(b.sent_at ?? '').localeCompare(String(a.sent_at ?? '')));
  const by_domain = [...domains.entries()].map(([d, c]) => row(d, d, c)).sort((a, b) => b.sent - a.sent).slice(0, 15);
  const by_week = [...weeks.entries()]
    .map(([w, v]) => ({ from: v.from, ...row(w, `ab ${v.from}`, v.c) }))
    .sort((a, b) => a.from.localeCompare(b.from));

  const warnings: Report['warnings'] = [];
  const add = (scope: string, r: Row) => {
    for (const i of r.issues) warnings.push({ level: i.level, scope, text: `${scope}: ${i.text}`, tip: i.tip });
  };
  const totalsRow = row('total', `Letzte ${days} Tage`, total);
  add(`Letzte ${days} Tage`, totalsRow);
  for (const c of by_campaign.filter((x) => x.sent_at && Date.parse(x.sent_at) >= Date.now() - 14 * 864e5)) add(`Kampagne „${c.label}“`, c);
  for (const d of by_domain.filter((x) => x.sent >= MIN_SAMPLE)) add(`Empfänger bei ${d.label}`, d);
  warnings.sort((a, b) => (a.level === b.level ? 0 : a.level === 'critical' ? -1 : 1));

  const from = String(app.location(locationId)?.settings?.email?.fromEmail ?? app.location(locationId)?.settings?.email?.user ?? '');
  return { days, since, sending_domain: from.includes('@') ? from.split('@')[1].toLowerCase() : '', totals: totalsRow, by_campaign, by_domain, by_week, warnings: warnings.slice(0, 8) };
}

/** The short verdict for banners (last 7 days of campaign mail). Cheap enough to ask on every campaign page. */
export function summary(app: App, locationId: string): { level: Level; text: string; issues: Issue[] } {
  return app.db.memo(`mk-rep:${locationId}`, 60_000, () => {
    const r = buildReport(app, locationId, { days: 7 });
    return { level: r.totals.level, text: r.warnings[0]?.text ?? '', issues: r.totals.issues };
  });
}
