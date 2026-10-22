import type { Module } from '../core/app.js';
import { bad, type Ctx } from '../core/http.js';
import { now } from '../core/util.js';
import { getContact } from '../services/contacts.js';
import { resolve, scopeClause } from '../services/record-access.js';
import type { Tool } from './mcp.js';

/**
 * Bulk "assign owner" for contacts (docs/api.md#contacts-bulk-owner): the contact list's bulk bar hands many contacts to one person
 * (or takes the owner away). Each changed contact emits `contact.updated` like a single edit, so the trigger "Zuständiger geändert"
 * runs for it; the whole request is one undo entry. Record access applies: a restricted person only reaches contacts they may see.
 */

const bodyIds = (body: any): string[] => (Array.isArray(body?.ids) ? [...new Set<string>(body.ids.map(String))].filter(Boolean).slice(0, 1000) : []);

const TOOLS: Tool[] = [
  {
    name: 'ghl_contacts_assign_owner',
    title: 'Kontakten einen Zuständigen geben',
    description: 'Gibt bis zu 1000 Kontakten (contact_ids) auf einmal einen Zuständigen (user_id, Nutzer aus ghl_pm_team bzw. /api/location-users) – oder entfernt ihn (user_id leer). Löst je Kontakt „Zuständiger geändert“ aus; rückgängig machbar.',
    inputSchema: {
      type: 'object',
      properties: { location_id: { type: 'string' }, contact_ids: { type: 'array', items: { type: 'string' } }, user_id: { type: 'string', description: 'leer = Zuständigen entfernen' } },
      required: ['contact_ids'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }, // a mass change: always confirmed
    run: (call, a) => call.api('POST', '/api/contacts/bulk-owner', { location: a.location_id, body: { ids: a.contact_ids, assigned_to: a.user_id || null } }),
  },
];

export const contactBulkOwnerModule: Module = {
  name: 'contact-bulk-owner',
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    router.post('/api/contacts/bulk-owner', 'location', (ctx) => {
      const ids = bodyIds(ctx.body);
      if (!ids.length) throw bad('ids: die gewählten Kontakte angeben');
      const owner = ctx.body?.assigned_to ? String(ctx.body.assigned_to) : null;
      if (owner && !db.get(`SELECT 1 AS x FROM users WHERE id = ? AND (role = 'admin' OR EXISTS (SELECT 1 FROM json_each(users.locations) WHERE value = ?))`, owner, ctx.locationId)) throw bad('Unbekannte Person');
      const scope = scopeClause(resolve(app, ctx), 'contacts', 'c');
      const own = db.all<{ id: string }>(
        `SELECT c.id FROM contacts c WHERE c.location_id = ? AND c.id IN (${ids.map(() => '?').join(',')})${scope ? ` AND ${scope.sql}` : ''}`,
        ctx.locationId,
        ...ids,
        ...((scope?.params ?? []) as string[]),
      );
      let count = 0;
      const changed: { id: string; previous: any }[] = [];
      db.tx(() => {
        for (const { id } of own) {
          const previous = getContact(app, ctx.locationId, id);
          if (!previous || (previous.assigned_to ?? null) === owner) continue;
          db.run('UPDATE contacts SET assigned_to = ?, updated_at = ? WHERE id = ?', owner, now(), id);
          changed.push({ id, previous });
          count++;
        }
      });
      for (const c of changed) app.events.emit(ctx.locationId, 'contact.updated', { contactId: c.id, contact: getContact(app, ctx.locationId, c.id), changed: ['assigned_to', 'updated_at'], previous: c.previous });
      return { count, skipped: ids.length - own.length };
    });

    const undo = app.services.undo as { track(rule: unknown): void } | undefined;
    if (undo) {
      undo.track({
        method: 'POST',
        pattern: '/api/contacts/bulk-owner',
        entity: 'contact',
        targets: (ctx: Ctx) => bodyIds(ctx.body).map((id) => ({ id })),
        action: () => 'bulk',
        groupLabel: (ctx: Ctx, rows: unknown[]) => {
          const n = rows.length;
          return `${n} ${n === 1 ? 'Kontakt' : 'Kontakte'}: ${ctx.body?.assigned_to ? 'neu zugewiesen' : 'Zuständigen entfernt'}`;
        },
      });
    }
  },
};
