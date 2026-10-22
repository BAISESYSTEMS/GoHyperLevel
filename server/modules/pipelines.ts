import type { Module } from '../core/app.js';
import { cached } from '../core/cache.js';
import { parseRows } from '../core/db.js';
import { HttpError, bad, clampLimit, notFound, str } from '../core/http.js';
import { id, now } from '../core/util.js';
import { upsertContact } from '../services/contacts.js';
import { assertContactUpsertAllowed, defaultOwner, maskContactFields, maskRow, resolve, scopeClause } from '../services/record-access.js';
import { cleanLostReasons, createOpportunity, getPipeline, lostReasonsOf, updateOpportunity } from '../services/opportunities.js';
import { DEAL_FROM, dealListSql, deniedDealFields } from '../services/deal-query.js';

const asHttp = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw bad((e as Error).message);
  }
};

function cleanStages(input: unknown, keep: { id: string; name: string }[] = []) {
  if (!Array.isArray(input) || !input.length) throw bad('Mindestens eine Stufe');
  return input.map((s: any) => {
    const name = str(typeof s === 'string' ? s : s?.name, 'Stufenname', { required: true, max: 80 });
    const sid = typeof s === 'object' && s?.id && keep.some((k) => k.id === s.id) ? s.id : id(8);
    // Optional win probability in % (weighted forecast in reports); empty = default by position.
    const p = typeof s === 'object' && s?.probability !== undefined && s?.probability !== null && s?.probability !== '' ? Number(s.probability) : NaN;
    // Optional colour of the stage header on the board (#rrggbb); anything else is dropped.
    const color = typeof s === 'object' && /^#[0-9a-f]{6}$/i.test(String(s?.color ?? '')) ? String(s.color).toLowerCase() : undefined;
    return { id: sid, name, ...(Number.isFinite(p) ? { probability: Math.max(0, Math.min(100, Math.round(p))) } : {}), ...(color ? { color } : {}) };
  });
}

export const pipelinesModule: Module = {
  name: 'pipelines',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE pipelines (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, stages TEXT NOT NULL DEFAULT '[]', external_id TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE opportunities (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE, stage_id TEXT NOT NULL,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        name TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open',
        assigned_to TEXT, source TEXT NOT NULL DEFAULT '', external_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, stage_changed_at TEXT
      );
      CREATE INDEX opportunities_pipeline ON opportunities(pipeline_id, stage_id);
      CREATE INDEX opportunities_contact ON opportunities(contact_id);
      `,
    ],
    // Deals like in HubSpot: expected close date, why a deal was lost (reasons per pipeline, NULL = defaults) and the deal's currency.
    [
      '002-deal-close-fields',
      `
      ALTER TABLE opportunities ADD COLUMN expected_close_date TEXT;
      ALTER TABLE opportunities ADD COLUMN lost_reason TEXT NOT NULL DEFAULT '';
      ALTER TABLE opportunities ADD COLUMN currency TEXT NOT NULL DEFAULT 'EUR';
      ALTER TABLE pipelines ADD COLUMN lost_reasons TEXT;
      CREATE INDEX opportunities_close ON opportunities(location_id, expected_close_date);
      `,
    ],
    // The order of the pipelines (dragged in the board's "Pipelines sortieren", modules/pipeline-board.ts); NULL = by creation.
    ['003-position', `ALTER TABLE pipelines ADD COLUMN position INTEGER;`],
  ],
  register(app) {
    const { db, router } = app;

    router.get('/api/pipelines', 'location', (ctx) => {
      // The open count follows the person's view of deals (record-access rules).
      const scope = scopeClause(resolve(app, ctx), 'deals', 'o');
      return parseRows(
        db.all(
          `SELECT p.*, (SELECT COUNT(*) FROM opportunities o WHERE o.pipeline_id = p.id AND o.status = 'open'${scope ? ` AND ${scope.sql}` : ''}) AS open_count
           FROM pipelines p WHERE p.location_id = ? ORDER BY p.position IS NULL, p.position, p.created_at`,
          ...(scope?.params ?? []),
          ctx.locationId,
        ),
        ['stages', 'lost_reasons'],
      ).map((p) => ({ ...p, lost_reason_options: lostReasonsOf(p) }));
    });
    router.post('/api/pipelines', 'location', (ctx) => {
      const row = { id: id(), location_id: ctx.locationId, name: str(ctx.body.name, 'Name', { required: true, max: 100 }), stages: cleanStages(ctx.body.stages ?? ['Neu', 'In Arbeit', 'Gewonnen']), lost_reasons: asHttp(() => cleanLostReasons(ctx.body.lost_reasons)), created_at: now() };
      db.insert('pipelines', row);
      return row;
    });
    router.patch('/api/pipelines/:id', 'location', (ctx) => {
      const p = getPipeline(app, ctx.locationId, ctx.params.id);
      if (!p) throw notFound();
      const patch: Record<string, any> = {};
      if (ctx.body.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true });
      if (ctx.body.stages !== undefined) {
        patch.stages = cleanStages(ctx.body.stages, p.stages);
        // Opportunities in a removed stage move to the first remaining one.
        const ids = patch.stages.map((s: any) => s.id);
        db.run(
          `UPDATE opportunities SET stage_id = ? WHERE pipeline_id = ? AND stage_id NOT IN (SELECT value FROM json_each(?))`,
          ids[0],
          p.id,
          JSON.stringify(ids),
        );
      }
      // Reasons offered when a deal is lost; an empty list goes back to the defaults.
      if (ctx.body.lost_reasons !== undefined) patch.lost_reasons = asHttp(() => cleanLostReasons(ctx.body.lost_reasons));
      db.update('pipelines', p.id, patch);
      const out = getPipeline(app, ctx.locationId, p.id);
      return { ...out, lost_reason_options: lostReasonsOf(out) };
    });
    router.delete('/api/pipelines/:id', 'location', (ctx) => {
      if (db.get<{ n: number }>('SELECT COUNT(*) n FROM pipelines WHERE location_id = ?', ctx.locationId)!.n <= 1) throw bad('Die letzte Pipeline bleibt');
      db.run('DELETE FROM pipelines WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });

    router.get('/api/opportunities', 'location', (ctx) => cached(app, ctx, 10_000, () => {
      const where = ['o.location_id = ?'];
      const params: any[] = [ctx.locationId];
      // Record-access rules (modules/record-access.ts): a person with a limited view sees their own / their team's deals.
      const access = resolve(app, ctx);
      const scope = scopeClause(access, 'deals', 'o');
      if (scope) (where.push(scope.sql), params.push(...scope.params));
      const pid = ctx.query.get('pipeline_id');
      if (pid) {
        where.push('o.pipeline_id = ?');
        params.push(pid);
      }
      const status = ctx.query.get('status');
      if (status && status !== 'all') {
        where.push('o.status = ?');
        params.push(status);
      }
      const cid = ctx.query.get('contact_id');
      if (cid) {
        where.push('o.contact_id = ?');
        params.push(cid);
      }
      const q = ctx.query.get('q');
      if (q) {
        where.push(`(o.name || ' ' || c.first_name || ' ' || c.last_name || ' ' || c.email) LIKE ?`);
        params.push(`%${q}%`);
      }
      // The list view's filters and sort (services/deal-query.ts): `filters` (JSON), `sort`, `owner`, `stage_id`, `tag`.
      const list = asHttp(() => dealListSql(app, ctx.locationId, ctx.query, deniedDealFields(access)));
      const rows = parseRows(
        db.all(
          `SELECT o.*, c.first_name, c.last_name, c.email, c.phone, c.company AS contact_company, c.tags AS contact_tags, rp.props AS props
           FROM ${DEAL_FROM}
           WHERE ${[...where, ...list.where].join(' AND ')} ORDER BY ${list.order} LIMIT ${clampLimit(ctx.query.get('limit'), 2000, 2000)}`,
          ...params,
          ...(list.params as any[]),
        ),
        ['contact_tags', 'props'],
      );
      return access ? rows.map((r) => maskContactFields(access, maskRow(access, 'deals', r))) : rows;
    }));

    router.post('/api/opportunities', 'location', (ctx) =>
      asHttp(() => {
        const access = resolve(app, ctx);
        let contactId = ctx.body.contact_id;
        if (!contactId && ctx.body.contact) {
          assertContactUpsertAllowed(app, access, ctx.body.contact);
          const made = upsertContact(app, ctx.locationId, ctx.body.contact, { source: 'Opportunity' }).contact;
          // A contact created by a person with a limited view belongs to them (else it would vanish from their own list).
          const owner = defaultOwner(access, 'contacts');
          if (owner && !made.assigned_to) db.run('UPDATE contacts SET assigned_to = ? WHERE id = ?', owner, made.id);
          contactId = made.id;
        }
        if (!contactId) throw bad('Kontakt fehlt');
        const mine = defaultOwner(access, 'deals');
        const deal = createOpportunity(app, ctx.locationId, { ...ctx.body, contact_id: contactId, ...(mine && !ctx.body.assigned_to ? { assigned_to: mine } : {}) });
        return access ? maskRow(access, 'deals', deal) : deal;
      }),
    );
    router.patch('/api/opportunities/:id', 'location', (ctx) => {
      // A deal with positions (modules/deal-lines.ts) gets its amount from them: changing it by hand would be overwritten at the next edit.
      if (ctx.body?.value !== undefined && app.services.dealValueLocked?.(ctx.locationId, ctx.params.id)) {
        const cur = db.get<{ value: number }>('SELECT value FROM opportunities WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
        if (cur && Math.round(Number(ctx.body.value) || 0) !== cur.value) throw new HttpError(409, 'Der Dealwert ergibt sich aus den Positionen des Deals – bitte dort ändern');
      }
      const deal = asHttp(() => updateOpportunity(app, ctx.locationId, ctx.params.id, ctx.body));
      const access = resolve(app, ctx);
      return access ? maskRow(access, 'deals', deal) : deal;
    });
    router.delete('/api/opportunities/:id', 'location', (ctx) => {
      db.run('DELETE FROM opportunities WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });
  },
};
