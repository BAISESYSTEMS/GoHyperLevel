import type { Module } from '../core/app.js';
import { HttpError, bad } from '../core/http.js';
import { resolve, scopeClause } from '../services/record-access.js';
import { callRoute } from '../services/route-call.js';
import type { Tool } from './mcp.js';

/**
 * Bulk actions on companies (docs/api.md#companies-bulk): give several companies one owner, delete them, or put the contacts linked
 * to them into a workflow – for the list and for agents. Each company goes through its normal route (`PATCH`/`DELETE
 * /api/companies/:id`, `POST /api/workflows/:id/enroll`), so validation, record access, the audit log and the undo journal apply
 * exactly as by hand; what fails is reported per company.
 */

const ACTIONS = ['owner', 'delete', 'enroll'] as const;
type Action = (typeof ACTIONS)[number];
const bodyIds = (body: any): string[] => (Array.isArray(body?.ids) ? [...new Set<string>(body.ids.map(String))].filter(Boolean).slice(0, 500) : []);

const TOOLS: Tool[] = [
  {
    name: 'ghl_companies_bulk',
    title: 'Mehrere Firmen bearbeiten',
    description:
      'Massenaktion für Firmen (IDs aus ghl_list_companies): owner (owner_id = Nutzer-ID oder leer), delete, enroll (die mit den Firmen verknüpften Kontakte in workflow_id aufnehmen). Jede Firma läuft über die normale Route; Fehler stehen je Firma in failed.',
    inputSchema: {
      type: 'object',
      properties: { location_id: { type: 'string' }, action: { type: 'string', enum: [...ACTIONS] }, ids: { type: 'array', items: { type: 'string' } }, owner_id: { type: 'string' }, workflow_id: { type: 'string' } },
      required: ['action', 'ids'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    klassFor: (a) => (a.action === 'delete' ? 'sensitive' : 'write'),
    run: (call, a) => call.api('POST', '/api/companies/bulk', { location: a.location_id, body: { action: a.action, ids: a.ids, owner_id: a.owner_id ?? null, workflow_id: a.workflow_id } }),
  },
];

export const companyBulkModule: Module = {
  name: 'company-bulk',
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    router.post('/api/companies/bulk', 'location', async (ctx) => {
      const action = String(ctx.body?.action ?? '') as Action;
      if (!ACTIONS.includes(action)) throw bad(`Unbekannte Aktion (${ACTIONS.join(', ')})`);
      const ids = bodyIds(ctx.body);
      if (!ids.length) throw bad('ids: die gewählten Firmen angeben');
      const own = db.all<{ id: string; name: string }>(`SELECT id, name FROM companies WHERE location_id = ? AND id IN (${ids.map(() => '?').join(',')})`, ctx.locationId, ...ids);
      if (own.length !== ids.length) throw bad('Unbekannte Firma');
      const failed: { id: string; name: string; error: string }[] = [];
      const msg = (e: unknown) => (e instanceof HttpError || e instanceof Error ? e.message : String(e));

      if (action === 'enroll') {
        const wf = String(ctx.body?.workflow_id ?? '');
        if (!wf) throw bad('workflow_id: den Workflow angeben');
        const contacts = db.all<{ cid: string }>(
          `SELECT DISTINCT CASE WHEN a.a_type = 'contact' THEN a.a_id ELSE a.b_id END AS cid FROM associations a
           WHERE a.location_id = ? AND ((a.a_type = 'contact' AND a.b_type = 'company' AND a.b_id IN (${ids.map(() => '?').join(',')}))
                                    OR (a.b_type = 'contact' AND a.a_type = 'company' AND a.a_id IN (${ids.map(() => '?').join(',')})))`,
          ctx.locationId,
          ...ids,
          ...ids,
        ).map((r) => r.cid);
        // Only contacts the person may see (record access).
        const scope = scopeClause(resolve(app, ctx), 'contacts', 'c');
        const visible = scope && contacts.length ? new Set(db.all<{ id: string }>(`SELECT c.id FROM contacts c WHERE c.location_id = ? AND ${scope.sql}`, ctx.locationId, ...(scope.params as string[])).map((r) => r.id)) : null;
        const allowed = visible ? contacts.filter((x) => visible.has(x)) : contacts;
        if (!allowed.length) return { count: 0, contacts: 0, enrolled: 0, failed };
        const r = await callRoute(app, ctx, 'POST', `/api/workflows/${encodeURIComponent(wf)}/enroll`, { contact_ids: allowed.slice(0, 5000) });
        return { count: own.length, contacts: allowed.length, enrolled: r?.enrolled ?? 0, failed };
      }

      let count = 0;
      for (const c of own) {
        try {
          if (action === 'delete') await callRoute(app, ctx, 'DELETE', `/api/companies/${encodeURIComponent(c.id)}`);
          else await callRoute(app, ctx, 'PATCH', `/api/companies/${encodeURIComponent(c.id)}`, { owner_id: ctx.body?.owner_id ? String(ctx.body.owner_id) : null });
          count++;
        } catch (e) {
          failed.push({ id: c.id, name: c.name, error: msg(e) });
        }
      }
      return { count, failed };
    });
  },
};
