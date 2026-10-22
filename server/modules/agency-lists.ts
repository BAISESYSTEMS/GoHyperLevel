import { cached } from '../core/cache.js';
import type { Module } from '../core/app.js';

/**
 * Agency-wide lists: every contact and every deal across all projects in one place, so nothing
 * hides in a sub-account you are not looking at right now.
 */

const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

export const agencyListsModule: Module = {
  name: 'agency-lists',
  register(app) {
    const { db, router } = app;

    router.get('/api/agency/contacts', 'admin', (ctx) => {
      const q = (ctx.query.get('q') ?? '').trim();
      const loc = ctx.query.get('location_id');
      const where: string[] = [];
      const params: any[] = [];
      if (q) {
        where.push(`(c.first_name || ' ' || c.last_name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR c.company LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\')`);
        params.push(like(q), like(q), like(q), like(q));
      }
      if (loc) {
        where.push('c.location_id = ?');
        params.push(loc);
      }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = Number(db.get(`SELECT COUNT(*) AS n FROM contacts c ${w}`, ...params)?.n ?? 0);
      const rows = db.all(
        `SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.company, c.tags, c.location_id, l.name AS project,
                c.last_activity_at, c.created_at,
                (SELECT COUNT(*) FROM opportunities o WHERE o.contact_id = c.id AND o.status = 'open') AS open_deals
         FROM contacts c JOIN locations l ON l.id = c.location_id ${w}
         ORDER BY COALESCE(c.last_activity_at, c.created_at) DESC LIMIT ?`,
        ...params,
        Math.min(Math.max(Number(ctx.query.get('limit')) || 300, 1), 1000),
      );
      return { total, contacts: rows.map((r) => ({ ...r, tags: JSON.parse(r.tags || '[]') })) };
    });

    router.get('/api/agency/opportunities', 'admin', (ctx) => cached(app, ctx, 10_000, () => {
      const status = ctx.query.get('status') ?? 'open';
      const q = (ctx.query.get('q') ?? '').trim();
      const where: string[] = [];
      const params: any[] = [];
      if (status !== 'all') {
        where.push('o.status = ?');
        params.push(status);
      }
      if (q) {
        where.push(`(o.name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR c.company LIKE ? ESCAPE '\\')`);
        params.push(like(q), like(q), like(q));
      }
      // Stage names come from the (few) pipelines, not from a join that repeats their JSON on every row.
      const stageNames = new Map<string, Map<string, string>>();
      const pipelineNames = new Map<string, string>();
      for (const p of db.all('SELECT id, name, stages FROM pipelines')) {
        pipelineNames.set(p.id, p.name);
        stageNames.set(p.id, new Map((JSON.parse(p.stages || '[]') as { id: string; name: string }[]).map((st) => [st.id, st.name])));
      }
      const rows = db.all(
        `SELECT o.id, o.name, o.value, o.status, o.location_id, l.name AS project, o.pipeline_id,
                o.stage_id, o.contact_id, c.first_name, c.last_name, c.email, o.updated_at
         FROM opportunities o JOIN locations l ON l.id = o.location_id
         LEFT JOIN contacts c ON c.id = o.contact_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY l.name, o.updated_at DESC LIMIT 2000`,
        ...params,
      );
      return rows.map((r) => ({ ...r, pipeline: pipelineNames.get(r.pipeline_id) ?? '', stage: stageNames.get(r.pipeline_id)?.get(r.stage_id) ?? '' }));
    }));
  },
};
