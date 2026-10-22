import type { Module } from '../core/app.js';
import { HttpError, notFound } from '../core/http.js';
import { limiter } from '../services/creator-kit.js';
import { assemble, cleanReport, type Aggregates } from '../services/form-analytics.js';
import type { FormField } from '../services/form-fields.js';
import { parseJson } from '../core/db.js';

/**
 * Per-field analytics for forms (docs/forms.md): the page reports opens, views, answers and the end (no cookie, no address, a random id per
 * visit, off when the browser says "Do Not Track"), the editor shows the funnel, answer rates, time per field and where people leave.
 */

const KEEP_DAYS = 180;

export const formAnalyticsModule: Module = {
  name: 'form-analytics',
  migrations: [
    [
      '001-events',
      `CREATE TABLE form_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE, session TEXT NOT NULL, kind TEXT NOT NULL,
        field TEXT NOT NULL DEFAULT '', ms INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL
      );
      CREATE INDEX form_events_form ON form_events(form_id, at);
      CREATE INDEX form_events_session ON form_events(form_id, session, id);`,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const trackLimit = limiter(240, 60_000);

    router.post('/api/public/forms/:id/track', 'public', (ctx) => {
      if (trackLimit(ctx.ip)) throw new HttpError(429, 'Zu viele Anfragen');
      if (ctx.rawBody.length > 8192) throw new HttpError(413, 'Zu groß');
      const form = parseJson(db.get<any>('SELECT id, location_id, fields, settings FROM forms WHERE id = ?', ctx.params.id), ['fields', 'settings']);
      if (!form) throw notFound();
      if (form.settings?.analytics === false) return { ok: true };
      const report = cleanReport(ctx.body, new Set((form.fields as FormField[]).map((f) => f.id)));
      if (!report) return { ok: true };
      const at = new Date().toISOString();
      db.tx(() => {
        for (const e of report.events) db.run('INSERT INTO form_events (location_id, form_id, session, kind, field, ms, at) VALUES (?, ?, ?, ?, ?, ?, ?)', form.location_id, form.id, report.session, e.kind, e.field, e.ms, at);
      });
      return { ok: true };
    });

    function aggregates(formId: string, since: string): Aggregates {
      const one = (sql: string, ...a: string[]) => db.get<{ n: number }>(sql, ...a)?.n ?? 0;
      const base = 'FROM form_events WHERE form_id = ? AND at >= ?';
      const per = (kind: string) => Object.fromEntries(db.all<{ field: string; n: number }>(`SELECT field, COUNT(DISTINCT session) AS n ${base} AND kind = ? AND field <> '' GROUP BY field`, formId, since, kind).map((r) => [r.field, r.n]));
      return {
        opened: one(`SELECT COUNT(DISTINCT session) AS n ${base}`, formId, since),
        started: one(`SELECT COUNT(DISTINCT session) AS n ${base} AND kind = 'a'`, formId, since),
        submitted: one(`SELECT COUNT(DISTINCT session) AS n ${base} AND kind = 's'`, formId, since),
        avg_submit_ms: db.get<{ a: number }>(`SELECT AVG(MIN(ms, 3600000)) AS a ${base} AND kind = 's' AND ms > 0`, formId, since)?.a ?? 0,
        views: per('v'),
        answered: per('a'),
        avg_ms: Object.fromEntries(db.all<{ field: string; a: number }>(`SELECT field, AVG(MIN(ms, 300000)) AS a ${base} AND kind = 'a' AND field <> '' GROUP BY field`, formId, since).map((r) => [r.field, r.a])),
        // The last question a visit showed, for visits that never submitted.
        dropoffs: Object.fromEntries(
          db
            .all<{ field: string; n: number }>(
              `SELECT last.field AS field, COUNT(*) AS n FROM (
                 SELECT e.session AS session, (SELECT e2.field FROM form_events e2 WHERE e2.form_id = e.form_id AND e2.session = e.session AND e2.kind IN ('v', 'l') AND e2.field <> '' ORDER BY e2.id DESC LIMIT 1) AS field
                 FROM form_events e WHERE e.form_id = ? AND e.at >= ? GROUP BY e.session HAVING SUM(CASE WHEN e.kind = 's' THEN 1 ELSE 0 END) = 0
               ) last WHERE last.field IS NOT NULL GROUP BY last.field`,
              formId,
              since,
            )
            .map((r) => [r.field, r.n]),
        ),
      };
    }

    router.get('/api/forms/:id/analytics', 'location', (ctx) => {
      const form = parseJson(db.get<any>('SELECT id, name, fields FROM forms WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId), ['fields']);
      if (!form) throw notFound();
      const days = Math.min(Math.max(Math.round(Number(ctx.query.get('days')) || 30), 1), KEEP_DAYS);
      const since = new Date(Date.now() - days * 864e5).toISOString();
      const daily = db
        .all<{ day: string; opened: number; submitted: number }>(
          `SELECT substr(at, 1, 10) AS day, COUNT(DISTINCT CASE WHEN kind = 'o' THEN session END) AS opened, COUNT(DISTINCT CASE WHEN kind = 's' THEN session END) AS submitted
           FROM form_events WHERE form_id = ? AND at >= ? GROUP BY day ORDER BY day`,
          form.id,
          since,
        );
      return { form: { id: form.id, name: form.name }, days, ...assemble(form.fields, aggregates(form.id, since)), daily, submissions: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM form_submissions WHERE form_id = ? AND created_at >= ?', form.id, since)!.n };
    });
    router.delete('/api/forms/:id/analytics', 'location', (ctx) => {
      if (!db.get('SELECT id FROM forms WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId)) throw notFound();
      db.run('DELETE FROM form_events WHERE form_id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });

    let swept = 0;
    app.onTick(() => {
      if (Date.now() - swept < 3600_000) return;
      swept = Date.now();
      db.run('DELETE FROM form_events WHERE at < ?', new Date(Date.now() - KEEP_DAYS * 864e5).toISOString());
    });
  },
};
