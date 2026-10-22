import type { Module } from '../core/app.js';
import type { Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { deliverEmail } from '../services/messaging.js';
import { backupCheck, diskCheck, diskFree, ErrorWindow, isSpike, overall, tickCheck, webhookRequest, type Alert, type HealthReport } from '../services/ops-alerts.js';
import { getBranding } from './agency.js';
import { PUSH_KINDS } from './push.js';

/**
 * Uptime and alerting (docs/backups.md#uptime-and-alerts).
 *
 * - `GET /healthz` (the route stays in core.ts; this module wraps it): database, free disk space, scheduler lag and backup age.
 *   200 `ok` when all is well; a failing check other than the database gives 200 `degraded: …` (platform health checks must not
 *   restart the app over an old backup); the database down gives 503. `?strict=1` answers 503 on any failing check – that is the
 *   address for an external monitor (UptimeRobot, Better Stack). `?format=json` lists the checks (statuses only, no numbers).
 * - Alerts once a minute: disk below 10 %, backup older than 2 h (off-site) or 26 h (local only), scheduler stalled, a spike of
 *   unexpected server errors, database down – by e-mail (PGHL_ALERT_EMAIL, default every admin), web push to admins and an optional
 *   webhook (PGHL_ALERT_WEBHOOK: ntfy, Slack, Discord, Telegram or plain JSON). Each problem alerts once, reminds every 6 h and
 *   says when it is over. Other modules raise one-off alerts through `app.services.opsAlert.event(alert)`.
 * - `app.services.opsEveryMinute`: functions run after each evaluation with the report (the status page samples from here).
 */

const REMIND_MS = 6 * 3600_000;
const EVENT_DEDUPE_MS = 6 * 3600_000;

interface AlertRow {
  id: string;
  key: string;
  severity: string;
  title: string;
  body: string;
  status: 'firing' | 'resolved' | 'event';
  first_at: string;
  last_sent_at: string | null;
  resolved_at: string | null;
  sent: string;
}

export const opsAlertsModule: Module = {
  name: 'ops-alerts',
  migrations: [
    [
      '001-init',
      `CREATE TABLE ops_alerts (
        id TEXT PRIMARY KEY, key TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL, first_at TEXT NOT NULL, last_sent_at TEXT, resolved_at TEXT, sent TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX ops_alerts_key ON ops_alerts(key, status);
      CREATE INDEX ops_alerts_first ON ops_alerts(first_at);`,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const startedAt = Date.now();
    let lastTickAt: number | undefined;
    const errors = new ErrorWindow();
    /** Request totals once a minute, to know how many requests the error window saw. */
    const totals: { at: number; total: number }[] = [];

    Object.assign(PUSH_KINDS, { ops: { label: 'Betrieb: Störungen, Backups und Missbrauch (nur Admins)', perm: '' } });

    // The scheduler's heartbeat: this job runs once per round.
    app.onTick(() => {
      lastTickAt = Date.now();
    });

    // Unexpected server errors (the 500s with a request id) – chained in front of whoever records them (modules/feedback-capture.ts).
    const prevError = app.services.serverError as ((e: unknown, ctx: Ctx, route?: unknown) => string | undefined) | undefined;
    app.services.serverError = (e: unknown, ctx: Ctx, route?: unknown) => {
      errors.add();
      return prevError?.(e, ctx, route);
    };

    const brand = () => getBranding(app).name || 'HyperLevel';
    const admins = () => db.all<{ id: string; email: string }>(`SELECT id, email FROM users WHERE role = 'admin' ORDER BY created_at`);
    const recipients = () => {
      const env = String(process.env.PGHL_ALERT_EMAIL ?? '').split(/[\s,;]+/).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
      return env.length ? env : admins().map((a) => a.email).filter(Boolean);
    };
    /** Alert mails go out of the operator's oldest own sub-account (in cloud mode never a customer's). */
    const sender = () => {
      let row: { id: string } | undefined;
      try {
        row = db.get<{ id: string }>('SELECT id FROM locations WHERE id NOT IN (SELECT location_id FROM cloud_locations) ORDER BY created_at LIMIT 1');
      } catch {
        row = db.get<{ id: string }>('SELECT id FROM locations ORDER BY created_at LIMIT 1');
      }
      return row ? app.location(row.id) : undefined;
    };

    /** Sends one alert on every configured channel; never throws. Returns what each channel did. */
    async function send(a: Alert): Promise<Record<string, string>> {
      const result: Record<string, string> = {};
      const subject = `${a.resolved ? '[Behoben]' : a.severity === 'critical' ? '[Alarm]' : '[Hinweis]'} ${brand()}: ${a.title}`;
      const text = `${a.body}\n\nInstanz: ${app.config.baseUrl}\nZeit: ${new Date().toISOString()}\nStatus: ${app.config.baseUrl}/app/agency/system`;
      const to = recipients();
      const loc = sender();
      if (to.length && loc) {
        try {
          const mail = app.services.alertMailer ?? deliverEmail;
          let logged = false;
          for (const r of to) {
            const res = (await mail(loc, { to: r, subject, text, html: `<pre style="font-family:inherit;white-space:pre-wrap">${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</pre>` })) as { status?: string } | undefined;
            // A sub-account without a mail provider only writes the mail to the log.
            if (res?.status === 'logged' && !app.services.alertMailer) logged = true;
          }
          result.email = logged ? `${to.length} (nur protokolliert – im Absender-Sub-Account ist kein E-Mail-Versand eingerichtet)` : `${to.length}`;
        } catch (e) {
          result.email = `Fehler: ${(e as Error).message.slice(0, 120)}`;
        }
      } else result.email = to.length ? 'kein Absender' : 'keine Empfänger';
      if (process.env.PGHL_ALERT_PUSH !== '0' && app.services.pushNotify) {
        try {
          const r = await app.services.pushNotify({ userIds: admins().map((u) => u.id), kind: 'ops', title: subject.slice(0, 120), body: a.body, url: '/app/agency/system', tag: `ops-${a.key}`, urgency: a.severity === 'critical' && !a.resolved ? 'high' : 'normal' });
          result.push = `${r?.sent ?? 0}`;
        } catch (e) {
          result.push = `Fehler: ${(e as Error).message.slice(0, 120)}`;
        }
      }
      const hook = String(process.env.PGHL_ALERT_WEBHOOK ?? '').trim();
      if (hook) {
        try {
          const req = webhookRequest(hook, a, brand());
          const res = await (app.services.alertFetch ?? fetch)(req.url, { ...req.init, signal: AbortSignal.timeout(10_000) });
          result.webhook = res.ok ? 'ok' : `HTTP ${res.status}`;
        } catch (e) {
          result.webhook = `Fehler: ${(e as Error).message.slice(0, 120)}`;
        }
      }
      return result;
    }
    const sentText = (r: Record<string, string>) => Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(' · ');

    function health(at = Date.now()): HealthReport {
      let dbCheck: HealthReport['checks']['db'];
      try {
        db.get('SELECT 1 AS x');
        dbCheck = { status: 'ok', detail: 'Antwortet' };
      } catch (e) {
        dbCheck = { status: 'fail', detail: `Datenbank antwortet nicht: ${(e as Error).message.slice(0, 120)}` };
      }
      const free = (app.services.opsDiskFree as ((dir: string) => ReturnType<typeof diskFree>) | undefined)?.(app.config.dataDir) ?? diskFree(app.config.dataDir);
      const backupAge = app.services.offsiteBackup?.age?.() ?? { source: process.env.PGHL_BACKUPS === '0' ? 'none' : 'local', maxMinutes: 26 * 60 };
      const checks = {
        db: dbCheck,
        disk: diskCheck(free),
        tick: tickCheck(app.services.opsLastTick?.() ?? lastTickAt, startedAt, app.config.tickMs, at),
        backup: backupCheck(backupAge, app.services.opsStartedAt ?? startedAt, at),
      };
      return { status: overall(checks), at: new Date(at).toISOString(), checks };
    }

    /** Opens, reminds or resolves the alert of one condition. */
    async function condition(key: string, failing: boolean, a: Omit<Alert, 'key'>) {
      const open = db.get<AlertRow>(`SELECT * FROM ops_alerts WHERE key = ? AND status = 'firing' ORDER BY first_at DESC LIMIT 1`, key);
      if (failing && !open) {
        const row = { id: id(), key, severity: a.severity, title: a.title, body: a.body, status: 'firing', first_at: now(), last_sent_at: now(), resolved_at: null, sent: '' };
        db.insert('ops_alerts', row);
        db.run('UPDATE ops_alerts SET sent = ? WHERE id = ?', sentText(await send({ key, ...a })), row.id);
      } else if (failing && open && Date.now() - Date.parse(open.last_sent_at ?? open.first_at) > REMIND_MS) {
        db.run('UPDATE ops_alerts SET last_sent_at = ?, body = ? WHERE id = ?', now(), a.body, open.id);
        db.run('UPDATE ops_alerts SET sent = ? WHERE id = ?', sentText(await send({ key, ...a, title: `${a.title} (weiterhin)` })), open.id);
      } else if (!failing && open) {
        db.run(`UPDATE ops_alerts SET status = 'resolved', resolved_at = ? WHERE id = ?`, now(), open.id);
        await send({ key, severity: 'info', title: `${open.title} – behoben`, body: `Seit ${open.first_at.slice(0, 16).replace('T', ' ')} UTC, jetzt wieder in Ordnung.`, resolved: true });
      }
    }

    async function evaluate(at = Date.now()): Promise<HealthReport> {
      const r = health(at);
      const total = app.perf.snapshot().requests.total;
      totals.push({ at, total });
      while (totals.length > 10 && at - totals[0].at > 6 * 60_000) totals.shift();
      const before = totals.find((x) => at - x.at <= 5 * 60_000) ?? totals[0];
      const reqs = Math.max(0, total - before.total);
      const errs = errors.count(at);
      const c = r.checks;
      await condition('db_down', c.db.status === 'fail', { severity: 'critical', title: 'Datenbank antwortet nicht', body: c.db.detail });
      await condition('disk_low', c.disk.status === 'fail', { severity: 'critical', title: 'Speicherplatz fast voll', body: c.disk.detail });
      await condition('backup_stale', c.backup.status === 'fail', { severity: 'critical', title: 'Backup zu alt', body: c.backup.detail });
      await condition('tick_stalled', c.tick.status === 'fail', { severity: 'critical', title: 'Hintergrund-Aufgaben hängen', body: c.tick.detail });
      await condition('error_spike', isSpike(errs, reqs), { severity: 'warning', title: 'Viele Serverfehler', body: `${errs} unerwartete Fehler in den letzten 5 Minuten (${reqs} Anfragen). Details: Agentur → Fehler & Wünsche und das Server-Log.` });
      for (const fn of (app.services.opsEveryMinute ?? []) as ((r: HealthReport) => void | Promise<void>)[]) {
        try {
          await fn(r);
        } catch (e) {
          console.error('[ops-alerts] minute hook', e);
        }
      }
      return r;
    }

    /** A one-off alert (restore test failed, abuse report, sending paused); the same key alerts at most every 6 h. */
    async function event(a: Alert): Promise<boolean> {
      const recent = db.get<AlertRow>(`SELECT * FROM ops_alerts WHERE key = ? AND status = 'event' ORDER BY first_at DESC LIMIT 1`, a.key);
      if (recent && Date.now() - Date.parse(recent.first_at) < EVENT_DEDUPE_MS) return false;
      const row = { id: id(), key: a.key, severity: a.severity, title: a.title, body: a.body, status: 'event', first_at: now(), last_sent_at: now(), resolved_at: null, sent: '' };
      db.insert('ops_alerts', row);
      db.run('UPDATE ops_alerts SET sent = ? WHERE id = ?', sentText(await send(a)), row.id);
      return true;
    }
    // Housekeeping: a year of alerts is plenty.
    let cleanedAt = 0;
    app.services.opsEveryMinute = [
      ...(app.services.opsEveryMinute ?? []),
      () => {
        if (Date.now() - cleanedAt < 864e5) return;
        cleanedAt = Date.now();
        db.run(`DELETE FROM ops_alerts WHERE first_at < ? AND status != 'firing'`, new Date(Date.now() - 365 * 864e5).toISOString());
      },
    ];

    app.services.ops = { health, evaluate, send };
    app.services.opsAlert = { event: (a: Alert) => void event(a).catch((e) => console.error('[ops-alerts]', e)), eventAsync: event };

    // Its own timer, not the scheduler: a stalled scheduler is one of the things it reports.
    if (app.config.tickMs > 0) {
      const timer = setInterval(() => void evaluate().catch((e) => console.error('[ops-alerts]', e)), 60_000);
      timer.unref();
    }

    app.router.wrappers.push((route, next) =>
      route.method === 'GET' && route.pattern === '/healthz'
        ? (ctx) => {
            const r = health();
            const strict = ctx.query.get('strict') === '1';
            const failing = Object.entries(r.checks).filter(([, c]) => c.status === 'fail').map(([k]) => k);
            const status = r.status === 'fail' || (strict && failing.length) ? 503 : 200;
            const headers = { 'cache-control': 'no-store' };
            if (ctx.query.get('format') === 'json') {
              return { __raw: true, status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ status: r.status, checks: Object.fromEntries(Object.entries(r.checks).map(([k, c]) => [k, c.status])) }) };
            }
            return { __raw: true, status, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' }, body: r.status === 'ok' ? 'ok' : `${r.status}: ${failing.join(', ')}` };
          }
        : next,
    );

    router.get('/api/admin/ops', 'admin', () => {
      const hook = String(process.env.PGHL_ALERT_WEBHOOK ?? '').trim();
      let hookHost = '';
      try {
        hookHost = hook ? new URL(hook).host : '';
      } catch {
        hookHost = 'ungültige Adresse';
      }
      const adminIds = admins().map((a) => a.id);
      const pushDevices = adminIds.length ? Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id IN (${adminIds.map(() => '?').join(',')})`, ...adminIds)?.n ?? 0) : 0;
      return {
        health: health(),
        healthz: `${app.config.baseUrl}/healthz?strict=1`,
        channels: { email: recipients(), email_from_env: !!process.env.PGHL_ALERT_EMAIL, push: process.env.PGHL_ALERT_PUSH === '0' ? -1 : pushDevices, webhook: hookHost },
        open: db.all<AlertRow>(`SELECT * FROM ops_alerts WHERE status = 'firing' ORDER BY first_at DESC`),
        recent: db.all<AlertRow>(`SELECT * FROM ops_alerts ORDER BY first_at DESC LIMIT 30`),
      };
    });
    router.post('/api/admin/ops/test-alert', 'admin', async () => ({ sent: await send({ key: 'test', severity: 'info', title: 'Test-Alarm', body: 'So sehen Alarme dieser Instanz aus. Alles in Ordnung.' }) }));
  },
};
