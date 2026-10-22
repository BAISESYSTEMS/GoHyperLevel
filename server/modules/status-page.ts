import type { App, Module } from '../core/app.js';
import { bad, html, notFound, str } from '../core/http.js';
import type { Param } from '../core/db.js';
import { id, now } from '../core/util.js';
import type { HealthReport } from '../services/ops-alerts.js';
import { bucketOf, COMPONENTS, currentStatus, dailyUptime, DAYS, IMPACT_LABEL, renderStatusPage, STATUS_LABEL, type Incident, type Sample } from '../services/status-page.js';
import { getBranding } from './agency.js';

/**
 * Public status page `/status` (docs/backups.md#status-page): components, 90 days of uptime from the instance's own health samples
 * (written every 5 minutes through `app.services.opsEveryMinute` of modules/ops-alerts.ts) and the incidents the operator writes
 * under Agentur → System. On by default in cloud mode, otherwise with PGHL_STATUS_PAGE=1 (PGHL_STATUS_PAGE=0 turns it off).
 * No external dependency: if the server is down, so is the page – an external monitor covers that (docs).
 */

const enabled = (app: App) => (process.env.PGHL_STATUS_PAGE ? process.env.PGHL_STATUS_PAGE === '1' : !!app.config.cloudMode);
const IMPACTS = Object.keys(IMPACT_LABEL);
const STATUSES = Object.keys(STATUS_LABEL);
const KEYS = COMPONENTS.map((c) => c.key);

interface IncidentRow {
  id: string;
  title: string;
  impact: string;
  components: string;
  status: string;
  started_at: string;
  resolved_at: string | null;
}

export const statusPageModule: Module = {
  name: 'status-page',
  migrations: [
    [
      '001-init',
      `CREATE TABLE status_samples (bucket INTEGER PRIMARY KEY, app INTEGER NOT NULL, jobs INTEGER NOT NULL, backup INTEGER NOT NULL);
      CREATE TABLE status_incidents (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, impact TEXT NOT NULL, components TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL,
        started_at TEXT NOT NULL, resolved_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX status_incidents_started ON status_incidents(started_at);
      CREATE TABLE status_updates (
        id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES status_incidents(id) ON DELETE CASCADE, status TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL
      );
      CREATE INDEX status_updates_incident ON status_updates(incident_id, at);`,
    ],
  ],
  register(app) {
    const { db, router } = app;

    /** One sample per 5-minute slot; within a slot the worst minute wins. */
    const record = (r: HealthReport, at = Date.now()) => {
      const v = { app: r.checks.db.status === 'fail' ? 0 : 1, jobs: r.checks.tick.status === 'fail' ? 0 : 1, backup: r.checks.backup.status === 'fail' ? 0 : 1 };
      db.run(
        `INSERT INTO status_samples (bucket, app, jobs, backup) VALUES (?, ?, ?, ?)
         ON CONFLICT(bucket) DO UPDATE SET app = MIN(app, excluded.app), jobs = MIN(jobs, excluded.jobs), backup = MIN(backup, excluded.backup)`,
        bucketOf(at), v.app, v.jobs, v.backup,
      );
    };
    let cleaned = 0;
    app.services.opsEveryMinute = [
      ...(app.services.opsEveryMinute ?? []),
      (r: HealthReport) => {
        record(r);
        if (Date.now() - cleaned > 864e5) {
          cleaned = Date.now();
          db.run('DELETE FROM status_samples WHERE bucket < ?', bucketOf(Date.now() - (DAYS + 10) * 864e5));
        }
      },
    ];
    app.services.statusPage = { record, enabled: () => enabled(app) };

    const incidents = (where: string, ...params: Param[]): Incident[] => {
      const rows = db.all<IncidentRow>(`SELECT * FROM status_incidents WHERE ${where} ORDER BY started_at DESC LIMIT 200`, ...params);
      const ups = rows.length ? db.all<{ incident_id: string; status: string; body: string; at: string }>(`SELECT incident_id, status, body, at FROM status_updates WHERE incident_id IN (${rows.map(() => '?').join(',')}) ORDER BY at DESC`, ...rows.map((r) => r.id)) : [];
      return rows.map((r) => ({ ...r, components: JSON.parse(r.components || '[]'), updates: ups.filter((u) => u.incident_id === r.id) }));
    };

    const view = (at = Date.now()) => {
      const since = bucketOf(at - DAYS * 864e5);
      const samples = db.all<Sample>('SELECT bucket, app, jobs, backup FROM status_samples WHERE bucket >= ? ORDER BY bucket', since);
      const first = db.get<{ b: number | null }>('SELECT MIN(bucket) AS b FROM status_samples')?.b ?? undefined;
      const u = dailyUptime(samples, { now: at, first: first ?? undefined });
      const latest = samples[samples.length - 1];
      const open = incidents(`status != 'resolved'`);
      const past = incidents(`status = 'resolved' AND started_at >= ?`, new Date(at - DAYS * 864e5).toISOString());
      const components = COMPONENTS.map((c) => ({ key: c.key, name: c.name, current: currentStatus(c.key, c.source, latest, open, at), daily: u.uptime[c.source], total: u.total[c.source] }));
      return { days: u.days, components, open, past };
    };

    router.get('/status', 'public', () => {
      if (!enabled(app)) throw notFound();
      const v = view();
      const page = renderStatusPage({ brand: getBranding(app).name || 'HyperLevel', now: Date.now(), ...v, abuseUrl: app.config.cloudMode ? '/abuse' : undefined });
      const r = html(page);
      r.headers['cache-control'] = 'no-store';
      r.headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
      return r;
    });

    // --- operator: incidents ---------------------------------------------------------------------------------------
    const clean = (b: any, cur?: IncidentRow) => {
      const title = b.title !== undefined ? str(b.title, 'Titel', { required: true, max: 160 }) : cur?.title ?? '';
      if (!title) throw bad('Titel fehlt');
      const impact = b.impact !== undefined ? String(b.impact) : cur?.impact ?? 'minor';
      if (!IMPACTS.includes(impact)) throw bad('Auswirkung: minor, major oder maintenance');
      const status = b.status !== undefined ? String(b.status) : cur?.status ?? 'investigating';
      if (!STATUSES.includes(status)) throw bad('Status: investigating, identified, monitoring oder resolved');
      const components = b.components !== undefined ? (Array.isArray(b.components) ? b.components.map(String) : []) : JSON.parse(cur?.components ?? '[]');
      if (components.some((k: string) => !KEYS.includes(k))) throw bad(`Unbekannte Komponente (erlaubt: ${KEYS.join(', ')})`);
      const message = b.message !== undefined ? str(b.message, 'Text', { max: 4000 }) : '';
      return { title, impact, status, components: JSON.stringify([...new Set(components)]), message };
    };
    const one = (iid: string) => {
      const r = incidents('id = ?', iid)[0];
      if (!r) throw notFound('Vorfall nicht gefunden');
      return r;
    };

    router.get('/api/admin/status-page', 'admin', () => ({
      enabled: enabled(app),
      url: `${app.config.baseUrl}/status`,
      ...view(),
    }));
    router.post('/api/admin/status-page/incidents', 'admin', (ctx) => {
      const v = clean(ctx.body);
      if (!v.message) throw bad('Bitte beschreiben, was los ist (wird öffentlich angezeigt)');
      const at = ctx.body.started_at ? new Date(String(ctx.body.started_at)).toISOString() : now();
      const iid = id();
      db.tx(() => {
        db.insert('status_incidents', { id: iid, title: v.title, impact: v.impact, components: v.components, status: v.status, started_at: at, resolved_at: v.status === 'resolved' ? now() : null, created_at: now(), updated_at: now() });
        db.insert('status_updates', { id: id(), incident_id: iid, status: v.status, body: v.message, at: now() });
      });
      return one(iid);
    });
    router.patch('/api/admin/status-page/incidents/:id', 'admin', (ctx) => {
      const cur = db.get<IncidentRow>('SELECT * FROM status_incidents WHERE id = ?', ctx.params.id);
      if (!cur) throw notFound('Vorfall nicht gefunden');
      const v = clean(ctx.body, cur);
      db.tx(() => {
        db.run('UPDATE status_incidents SET title = ?, impact = ?, components = ?, status = ?, resolved_at = ?, updated_at = ? WHERE id = ?', v.title, v.impact, v.components, v.status, v.status === 'resolved' ? (cur.resolved_at ?? now()) : null, now(), cur.id);
        if (v.message) db.insert('status_updates', { id: id(), incident_id: cur.id, status: v.status, body: v.message, at: now() });
      });
      return one(cur.id);
    });
    router.delete('/api/admin/status-page/incidents/:id', 'admin', (ctx) => {
      if (!db.run('DELETE FROM status_incidents WHERE id = ?', ctx.params.id).changes) throw notFound('Vorfall nicht gefunden');
      return { ok: true };
    });
  },
};
