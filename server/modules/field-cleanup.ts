import type { Module } from '../core/app.js';
import { bad, type Ctx } from '../core/http.js';
import { tableEntity } from '../services/undo-table.js';
import type { Tool } from './mcp.js';

/**
 * Custom field clean-up (docs/api.md#custom-fields-clean-up): how much each contact field is used – contacts with a value, forms that
 * fill it (`custom.<key>`), workflows that read or write it – and deleting several at once. Fields that still hold values are kept
 * unless `force` is set; even then only the definition goes (the values stay on the contacts, like a single delete). One undo
 * entry brings every deleted definition back.
 */

const bodyIds = (body: any): string[] => (Array.isArray(body?.ids) ? [...new Set<string>(body.ids.map(String))].filter(Boolean).slice(0, 500) : []);

interface Usage {
  id: string;
  key: string;
  label: string;
  type: string;
  contacts: number;
  forms: { id: string; name: string }[];
  workflows: { id: string; name: string }[];
  unused: boolean;
}

const TOOLS: Tool[] = [
  {
    name: 'ghl_custom_fields_usage',
    title: 'Eigene Kontaktfelder mit Nutzung',
    description: 'Alle eigenen Kontaktfelder mit Nutzung: Anzahl Kontakte mit Wert, Formulare, die das Feld füllen, und Workflows, die es nennen. unused=true heißt: nirgends verwendet.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, unused_only: { type: 'boolean' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      const r = await call.api('GET', '/api/custom-fields/usage', { location: a.location_id });
      return a.unused_only ? { fields: r.fields.filter((f: Usage) => f.unused) } : r;
    },
  },
  {
    name: 'ghl_custom_fields_delete',
    title: 'Eigene Kontaktfelder löschen (mehrere)',
    description: 'Löscht mehrere eigene Kontaktfelder (ids aus ghl_custom_fields_usage). Felder, die noch Werte, Formulare oder Workflows haben, bleiben ohne force=true stehen (skipped). Die Werte an den Kontakten bleiben immer erhalten; rückgängig machbar.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } }, force: { type: 'boolean' } }, required: ['ids'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    klassFor: (a) => (a.force ? 'sensitive' : 'write'),
    run: (call, a) => call.api('POST', '/api/custom-fields/bulk-delete', { location: a.location_id, body: { ids: a.ids, force: a.force === true } }),
  },
];

export const fieldCleanupModule: Module = {
  name: 'field-cleanup',
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    const usage = (locationId: string): Usage[] => {
      const fields = db.all<{ id: string; key: string; label: string; type: string }>('SELECT id, key, label, type FROM custom_fields WHERE location_id = ? ORDER BY position, label', locationId);
      if (!fields.length) return [];
      // One pass over the contacts: how many hold a non-empty value per key.
      const counts = new Map(
        db
          .all<{ key: string; n: number }>(
            `SELECT j.key AS key, COUNT(*) AS n FROM contacts c, json_each(CASE WHEN json_valid(c.custom) THEN c.custom ELSE '{}' END) j
             WHERE c.location_id = ? AND j.value IS NOT NULL AND j.value != '' AND j.value != '[]' GROUP BY j.key`,
            locationId,
          )
          .map((r) => [r.key, r.n]),
      );
      const forms = db.all<{ id: string; name: string; text: string }>('SELECT id, name, fields AS text FROM forms WHERE location_id = ?', locationId);
      const wfs = db.all<{ id: string; name: string; text: string }>(`SELECT id, name, trigger || ' ' || steps AS text FROM workflows WHERE location_id = ?`, locationId);
      const names = (rows: { id: string; name: string; text: string }[], key: string) => rows.filter((r) => new RegExp(`custom\\.${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`).test(r.text)).map((r) => ({ id: r.id, name: r.name }));
      return fields.map((f) => {
        const contacts = counts.get(f.key) ?? 0;
        const inForms = names(forms, f.key);
        const inWorkflows = names(wfs, f.key);
        return { ...f, contacts, forms: inForms, workflows: inWorkflows, unused: !contacts && !inForms.length && !inWorkflows.length };
      });
    };

    router.get('/api/custom-fields/usage', 'location', (ctx) => ({ fields: usage(ctx.locationId) }));

    router.post('/api/custom-fields/bulk-delete', 'location', (ctx) => {
      const ids = bodyIds(ctx.body);
      if (!ids.length) throw bad('ids: die gewählten Felder angeben');
      const force = ctx.body?.force === true;
      const all = new Map(usage(ctx.locationId).map((f) => [f.id, f]));
      const unknown = ids.filter((x) => !all.has(x));
      if (unknown.length) throw bad('Unbekanntes Feld');
      const go = ids.filter((x) => force || all.get(x)!.unused);
      const skipped = ids.filter((x) => !go.includes(x)).map((x) => ({ id: x, label: all.get(x)!.label, contacts: all.get(x)!.contacts, forms: all.get(x)!.forms.length, workflows: all.get(x)!.workflows.length }));
      if (go.length) db.run(`DELETE FROM custom_fields WHERE location_id = ? AND id IN (${go.map(() => '?').join(',')})`, ctx.locationId, ...go);
      return { count: go.length, deleted: go, skipped };
    });

    const undo = app.services.undo as { register(type: string, e: unknown): void; track(rule: unknown): void } | undefined;
    if (undo) {
      undo.register(
        'custom_field',
        tableEntity(app, {
          noun: 'Kontaktfeld',
          plural: 'Kontaktfelder',
          area: 'settings',
          table: 'custom_fields',
          title: (r) => String(r.label),
          contactCol: null,
          fields: { label: { label: 'Bezeichnung' }, key: { label: 'Schlüssel' }, type: { label: 'Typ' } },
        }),
      );
      undo.track({
        method: 'POST',
        pattern: '/api/custom-fields/bulk-delete',
        entity: 'custom_field',
        targets: (ctx: Ctx) => bodyIds(ctx.body).map((id) => ({ id })),
        action: (_b: unknown, a: unknown) => (!a ? 'delete' : 'update'),
        groupLabel: (_ctx: Ctx, rows: unknown[]) => `${rows.length} ${rows.length === 1 ? 'Kontaktfeld' : 'Kontaktfelder'} gelöscht`,
      });
    }
  },
};
