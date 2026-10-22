import type { Module } from '../core/app.js';
import { toCsv } from '../core/csv.js';
import { parseRows } from '../core/db.js';
import { HttpError, bad, type Ctx, type RawResult } from '../core/http.js';
import { DEAL_FROM, dealListSql, dealProps, deniedDealFields } from '../services/deal-query.js';
import { getPipeline, updateOpportunity } from '../services/opportunities.js';
import { maskContactFields, maskRow, resolve, scopeClause } from '../services/record-access.js';

/**
 * The opportunity list view's server side (docs/api.md, Pipelines): bulk actions on selected deals (stage, owner, delete – one
 * undo entry for the whole request) and the CSV export of what the list shows (same filters as `GET /api/opportunities`).
 * Tags of the deals' contacts go through `POST /api/contacts/bulk`, which journals them as contact changes.
 */

const asHttp = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw bad((e as Error).message);
  }
};

const STATUS: Record<string, string> = { open: 'offen', won: 'gewonnen', lost: 'verloren', abandoned: 'aufgegeben' };
const MAX_EXPORT = 20_000;

export const dealListModule: Module = {
  name: 'deal-list',
  register(app) {
    const { db, router } = app;

    /** The ids of the body that are deals of this sub-account the person may see (record access). */
    const ownDeals = (ctx: Ctx): { id: string; pipeline_id: string; stage_id: string }[] => {
      const ids = Array.isArray(ctx.body?.ids) ? [...new Set<string>(ctx.body.ids.map(String))].filter(Boolean).slice(0, 1000) : [];
      if (!ids.length) throw bad('ids: die gewählten Deals angeben');
      const scope = scopeClause(resolve(app, ctx), 'deals', 'o');
      return db.all(
        `SELECT o.id, o.pipeline_id, o.stage_id FROM opportunities o WHERE o.location_id = ? AND o.id IN (${ids.map(() => '?').join(',')})${scope ? ` AND ${scope.sql}` : ''}`,
        ctx.locationId,
        ...ids,
        ...((scope?.params ?? []) as string[]),
      );
    };

    router.post('/api/opportunities/bulk', 'location', (ctx) => {
      const action = String(ctx.body?.action ?? '');
      const deals = ownDeals(ctx);
      let count = 0;
      let skipped = 0;
      if (action === 'stage') {
        const stageId = String(ctx.body.stage_id ?? '');
        const target = ctx.body.pipeline_id ? getPipeline(app, ctx.locationId, String(ctx.body.pipeline_id)) : null;
        if (ctx.body.pipeline_id && !target) throw bad('Pipeline nicht gefunden');
        if (target && !target.stages.some((s: any) => s.id === stageId)) throw bad('Stufe gehört nicht zur Pipeline');
        if (!stageId) throw bad('stage_id fehlt');
        db.tx(() => {
          for (const d of deals) {
            const p = target ?? getPipeline(app, ctx.locationId, d.pipeline_id);
            // Without a target pipeline only deals of the pipeline that has this stage move; the others are skipped.
            if (!p?.stages.some((s: any) => s.id === stageId)) {
              skipped++;
              continue;
            }
            if (d.pipeline_id === p.id && d.stage_id === stageId) continue;
            asHttp(() => updateOpportunity(app, ctx.locationId, d.id, { ...(d.pipeline_id !== p.id ? { pipeline_id: p.id } : {}), stage_id: stageId }));
            count++;
          }
        });
      } else if (action === 'owner') {
        const owner = ctx.body.assigned_to ? String(ctx.body.assigned_to) : null;
        if (owner && !db.get(`SELECT 1 AS x FROM users WHERE id = ? AND (role = 'admin' OR EXISTS (SELECT 1 FROM json_each(users.locations) WHERE value = ?))`, owner, ctx.locationId)) throw bad('Unbekannte Person');
        db.tx(() => {
          for (const d of deals) {
            asHttp(() => updateOpportunity(app, ctx.locationId, d.id, { assigned_to: owner }));
            count++;
          }
        });
      } else if (action === 'delete') {
        if (deals.length) count = db.run(`DELETE FROM opportunities WHERE location_id = ? AND id IN (${deals.map(() => '?').join(',')})`, ctx.locationId, ...deals.map((d) => d.id)).changes;
      } else throw bad('Unbekannte Aktion (stage, owner, delete)');
      return { count, skipped };
    });

    // The deals the list shows (or the selected ones, `ids=a,b`), as CSV for Excel: deal, contact, pipeline, stage, custom properties.
    router.get('/api/opportunities/export.csv', 'location', (ctx) => {
      const access = resolve(app, ctx);
      const where = ['o.location_id = ?'];
      const params: unknown[] = [ctx.locationId];
      const scope = scopeClause(access, 'deals', 'o');
      if (scope) (where.push(scope.sql), params.push(...scope.params));
      for (const k of ['pipeline_id', 'contact_id'] as const) {
        const v = ctx.query.get(k);
        if (v) (where.push(`o.${k} = ?`), params.push(v));
      }
      const status = ctx.query.get('status');
      if (status && status !== 'all') (where.push('o.status = ?'), params.push(status));
      const q = ctx.query.get('q');
      if (q) (where.push(`(o.name || ' ' || c.first_name || ' ' || c.last_name || ' ' || c.email) LIKE ?`), params.push(`%${q}%`));
      const ids = (ctx.query.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 2000);
      if (ids.length) (where.push(`o.id IN (${ids.map(() => '?').join(',')})`), params.push(...ids));
      const list = asHttp(() => dealListSql(app, ctx.locationId, ctx.query, deniedDealFields(access)));
      const rows = parseRows(
        db.all(
          `SELECT o.*, c.first_name, c.last_name, c.email, c.phone, c.company AS contact_company, c.tags AS contact_tags, rp.props AS props
           FROM ${DEAL_FROM} WHERE ${[...where, ...list.where].join(' AND ')} ORDER BY ${list.order} LIMIT ${MAX_EXPORT}`,
          ...(params as string[]),
          ...(list.params as string[]),
        ),
        ['contact_tags', 'props'],
      ).map((r) => (access ? maskContactFields(access, maskRow(access, 'deals', r)) : r));
      const pipes = new Map(parseRows(db.all('SELECT id, name, stages FROM pipelines WHERE location_id = ?', ctx.locationId), ['stages']).map((p) => [p.id, p]));
      const users = new Map(db.all<{ id: string; name: string }>('SELECT id, name FROM users').map((u) => [u.id, u.name]));
      const props = dealProps(app, ctx.locationId);
      const header = ['Name', 'Kontakt', 'E-Mail', 'Telefon', 'Firma', 'Pipeline', 'Stufe', 'Status', 'Wert', 'Währung', 'Zuständig', 'Erwarteter Abschluss', 'Quelle', 'Verlustgrund', 'Tags', 'Angelegt', 'Geändert', ...props.map((p) => p.label)];
      const lines = rows.map((r) => {
        const p = pipes.get(r.pipeline_id);
        const cell = (v: unknown) => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v));
        return [
          r.name,
          [r.first_name, r.last_name].filter(Boolean).join(' '),
          r.email,
          r.phone,
          r.contact_company,
          p?.name ?? '',
          p?.stages?.find((s: any) => s.id === r.stage_id)?.name ?? '',
          STATUS[r.status] ?? r.status,
          r.value,
          r.currency,
          r.assigned_to ? (users.get(r.assigned_to) ?? '') : '',
          r.expected_close_date ?? '',
          r.source,
          r.lost_reason,
          (r.contact_tags ?? []).join(', '),
          r.created_at,
          r.updated_at,
          ...props.map((d) => cell(r.props?.[d.key])),
        ];
      });
      const body = `﻿${toCsv([header, ...lines])}\r\n`;
      return { __raw: true, status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="opportunities.csv"' }, body } satisfies RawResult;
    });

    // --- undo: a bulk change is one entry, one click takes all of it back --------------------------------------------------
    const undo = app.services.undo as { track(rule: unknown): void } | undefined;
    if (undo) {
      const bodyIds = (ctx: Ctx) => (Array.isArray(ctx.body?.ids) ? ctx.body.ids.map(String).filter(Boolean).slice(0, 1000).map((id: string) => ({ id })) : []);
      undo.track({
        method: 'POST',
        pattern: '/api/opportunities/bulk',
        entity: 'deal',
        targets: bodyIds,
        deep: (ctx: Ctx) => ctx.body?.action === 'delete',
        action: (_b: unknown, a: unknown) => (!a ? 'delete' : 'bulk'),
        groupLabel: (ctx: Ctx, rows: unknown[]) => {
          const n = rows.length;
          const what = ctx.body?.action === 'delete' ? 'gelöscht' : ctx.body?.action === 'owner' ? 'neu zugewiesen' : 'in andere Stufe verschoben';
          return `${n} ${n === 1 ? 'Deal' : 'Deals'} ${what}`;
        },
      });
    }
  },
};
