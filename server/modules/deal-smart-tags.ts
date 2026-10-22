import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, str } from '../core/http.js';
import { id, now } from '../core/util.js';
import { resolve, scopeClause } from '../services/record-access.js';
import type { SnapshotPart } from '../services/snapshots.js';
import { cleanColor } from '../services/tag-meta.js';
import type { Tool } from './mcp.js';

/**
 * Smart Tags on deal cards (docs/sales.md#smart-tags): rules that put a coloured chip on open deals – high value, overdue, no
 * close date, no owner, stuck in a stage for N days, no activity for N days ("Deal verrottet"). Up to 60 rules per sub-account,
 * evaluated in SQL when the board loads (`GET /api/deal-smart-tags/board`), one query per rule. Rules travel in snapshots.
 */

export const KINDS = ['value_min', 'overdue', 'no_close_date', 'no_owner', 'stage_days', 'stale_days'] as const;
export type Kind = (typeof KINDS)[number];
const NEEDS_VALUE: Kind[] = ['value_min', 'stage_days', 'stale_days'];
const MAX_RULES = 60;

export interface Rule {
  kind: Kind;
  value?: number;
  pipeline_id?: string | null;
}

/** A clean rule or an error message. */
export function cleanRule(v: any): Rule {
  const kind = String(v?.kind ?? '') as Kind;
  if (!KINDS.includes(kind)) throw new Error(`Regel: unbekannte Art (${KINDS.join(', ')})`);
  const out: Rule = { kind };
  if (NEEDS_VALUE.includes(kind)) {
    const n = Number(v?.value);
    if (!Number.isFinite(n) || n < (kind === 'value_min' ? 0 : 1) || n > 1e12) throw new Error(kind === 'value_min' ? 'Regel: Mindestwert angeben' : 'Regel: Anzahl Tage angeben (ab 1)');
    out.value = kind === 'value_min' ? n : Math.round(n);
  }
  if (v?.pipeline_id) out.pipeline_id = String(v.pipeline_id).slice(0, 64);
  return out;
}

/** The SQL condition of a rule on `opportunities o` joined with `contacts c` (values as parameters). */
export function ruleSql(r: Rule, today: string, nowIso: string): { sql: string; params: (string | number)[] } {
  const ago = (days: number) => new Date(Date.parse(nowIso) - days * 864e5).toISOString();
  const base = r.pipeline_id ? { sql: ' AND o.pipeline_id = ?', params: [r.pipeline_id] } : { sql: '', params: [] as string[] };
  const one = (sql: string, ...params: (string | number)[]) => ({ sql: `(${sql})${base.sql}`, params: [...params, ...base.params] });
  switch (r.kind) {
    case 'value_min':
      return one('o.value >= ?', r.value ?? 0);
    case 'overdue':
      return one(`o.expected_close_date IS NOT NULL AND o.expected_close_date != '' AND substr(o.expected_close_date, 1, 10) < ?`, today);
    case 'no_close_date':
      return one(`o.expected_close_date IS NULL OR o.expected_close_date = ''`);
    case 'no_owner':
      return one(`o.assigned_to IS NULL OR o.assigned_to = ''`);
    case 'stage_days':
      return one('COALESCE(o.stage_changed_at, o.created_at) < ?', ago(r.value ?? 30));
    case 'stale_days':
      return one(`MAX(COALESCE(o.updated_at, o.created_at), COALESCE(c.last_activity_at, '')) < ?`, ago(r.value ?? 14));
  }
}

const TOOLS: Tool[] = [
  {
    name: 'ghl_deal_smart_tags',
    title: 'Smart Tags der Deals',
    description: 'Regeln für farbige Chips auf Deal-Karten (hoher Wert, überfällig, ohne Abschlussdatum, ohne Zuständigen, zu lange in einer Stufe, ohne Aktivität) und welche offenen Deals sie gerade markieren – gut, um verrottende Deals zu finden.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, pipeline_id: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      const rules = await call.api('GET', '/api/deal-smart-tags', { location: a.location_id });
      const board = await call.api('GET', `/api/deal-smart-tags/board${a.pipeline_id ? `?pipeline_id=${encodeURIComponent(String(a.pipeline_id))}` : ''}`, { location: a.location_id });
      return { rules, deals: board };
    },
  },
];

const asHttp = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw bad((e as Error).message);
  }
};

export const dealSmartTagsModule: Module = {
  name: 'deal-smart-tags',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE deal_smart_tags (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '', rule TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE INDEX deal_smart_tags_location ON deal_smart_tags(location_id, position);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    const list = (loc: string) => db.all<any>('SELECT id, name, color, rule, position FROM deal_smart_tags WHERE location_id = ? ORDER BY position, created_at', loc).map((r) => ({ ...r, rule: JSON.parse(r.rule) as Rule }));
    const one = (loc: string, tid: string) => list(loc).find((r) => r.id === tid);
    const today = (loc: string) => new Intl.DateTimeFormat('en-CA', { timeZone: app.location(loc)?.timezone || 'Europe/Berlin' }).format(new Date());

    router.get('/api/deal-smart-tags', 'location', (ctx) => list(ctx.locationId));
    router.post('/api/deal-smart-tags', 'location', (ctx) => {
      const name = str(ctx.body?.name, 'Name', { required: true, max: 40 });
      const rule = asHttp(() => cleanRule(ctx.body?.rule));
      const color = asHttp(() => cleanColor(ctx.body?.color));
      if (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM deal_smart_tags WHERE location_id = ?', ctx.locationId)!.n >= MAX_RULES) throw bad(`Höchstens ${MAX_RULES} Smart Tags`);
      const pos = db.get<{ p: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM deal_smart_tags WHERE location_id = ?', ctx.locationId)!.p;
      const row = { id: id(), location_id: ctx.locationId, name, color, rule, position: pos, created_at: now() };
      db.insert('deal_smart_tags', row);
      return one(ctx.locationId, row.id);
    });
    router.patch('/api/deal-smart-tags/:id', 'location', (ctx) => {
      if (!one(ctx.locationId, ctx.params.id)) throw notFound('Smart Tag nicht gefunden');
      const patch: Record<string, unknown> = {};
      if (ctx.body?.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true, max: 40 });
      if (ctx.body?.color !== undefined) patch.color = asHttp(() => cleanColor(ctx.body.color));
      if (ctx.body?.rule !== undefined) patch.rule = asHttp(() => cleanRule(ctx.body.rule));
      if (ctx.body?.position !== undefined) patch.position = Math.max(0, Math.min(1000, Math.round(Number(ctx.body.position) || 0)));
      if (Object.keys(patch).length) db.update('deal_smart_tags', ctx.params.id, patch, ctx.locationId);
      return one(ctx.locationId, ctx.params.id);
    });
    router.delete('/api/deal-smart-tags/:id', 'location', (ctx) => {
      if (!db.run('DELETE FROM deal_smart_tags WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId).changes) throw notFound('Smart Tag nicht gefunden');
      return { ok: true };
    });

    // Which open deals each rule marks: { dealId: [{ id, name, color }] } (only deals with at least one chip).
    router.get('/api/deal-smart-tags/board', 'location', (ctx) => {
      const rules = list(ctx.locationId);
      const out: Record<string, { id: string; name: string; color: string }[]> = {};
      if (!rules.length) return out;
      const pid = ctx.query.get('pipeline_id');
      const d = today(ctx.locationId);
      const at = new Date().toISOString();
      const access = resolve(app, ctx);
      const scope = scopeClause(access, 'deals', 'o');
      // A value rule would tell somebody whose deal amounts are hidden (record access) how big a deal is: it marks nothing for them.
      const valueHidden = !!access?.hidden.deals.has('value');
      for (const r of rules) {
        if (r.rule.pipeline_id && pid && r.rule.pipeline_id !== pid) continue;
        if (valueHidden && r.rule.kind === 'value_min') continue;
        const cond = ruleSql(r.rule, d, at);
        const rows = db.all<{ id: string }>(
          `SELECT o.id FROM opportunities o LEFT JOIN contacts c ON c.id = o.contact_id
           WHERE o.location_id = ? AND o.status = 'open'${pid ? ' AND o.pipeline_id = ?' : ''}${scope ? ` AND ${scope.sql}` : ''} AND ${cond.sql} LIMIT 5000`,
          ctx.locationId,
          ...(pid ? [pid] : []),
          ...((scope?.params ?? []) as string[]),
          ...cond.params,
        );
        for (const x of rows) (out[x.id] ??= []).push({ id: r.id, name: r.name, color: r.color });
      }
      return out;
    });

    const part: SnapshotPart = {
      key: 'deal_smart_tags',
      export: (_a: App, loc: string, only?: unknown) => (only ? [] : list(loc).map((r) => ({ name: r.name, color: r.color, rule: { ...r.rule, pipeline_id: undefined } }))),
      apply: (_a: App, loc: string, items: Record<string, any>[], c: any) => {
        let n = 0;
        for (const it of items ?? []) {
          try {
            const name = String(it.name ?? '').slice(0, 40);
            if (!name || db.get('SELECT 1 AS x FROM deal_smart_tags WHERE location_id = ? AND name = ?', loc, name)) continue;
            db.insert('deal_smart_tags', { id: id(), location_id: loc, name, color: cleanColor(it.color), rule: cleanRule(it.rule), position: n, created_at: now() });
            n++;
          } catch {
            /* a broken item is skipped */
          }
        }
        if (c?.created) c.created.deal_smart_tags = n;
      },
    };
    app.services.snapshotParts = [...(app.services.snapshotParts ?? []), part];
  },
};
