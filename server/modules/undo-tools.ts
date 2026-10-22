import type { Module } from '../core/app.js';
import { bad, clampLimit, type Ctx } from '../core/http.js';
import { callRoute, ownLocation, visibleLocations } from '../services/mobile.js';
import type { Journal } from '../services/undo-journal.js';
import type { Tool } from './mcp.js';

/**
 * Rückgängig for agents and phones (docs/undo.md):
 * - MCP tools `ghl_undo_list` (recent changes, filterable by who made them: a person, an API key, MCP, the HyperLevel Agent)
 *   and `ghl_undo` (restore one) – so an agent can roll back its own mistakes. The HyperLevel Agent picks them up like any tool.
 * - Mobile API `GET /api/mobile/undo/recent` and `POST /api/mobile/undo/:id` for an undo snackbar in the Android app.
 * Both go through the regular /api/undo routes, so rights, sub-account isolation and the audit log are the same.
 */

const obj = (props: Record<string, any>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const q = (params: Record<string, unknown>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
};

const TOOLS: Tool[] = [
  {
    name: 'ghl_undo_list',
    title: 'Letzte Änderungen (Rückgängig)',
    description:
      'Die letzten Änderungen eines Projekts, die sich rückgängig machen lassen – mit Wer (Person, API-Schlüssel, MCP, HyperLevel Agent), Was, Wann und vorher → nachher. actor: me (Standard: meine eigenen / die dieses Schlüssels), agent (HyperLevel Agent), api_key, mcp, agency_key, user (Personen), all (nur Admins/Agentur-Schlüssel sehen die Änderungen anderer). Gelöschtes mit Papierkorb: trash=true. Jeder Eintrag hat eine id für ghl_undo.',
    inputSchema: obj(
      {
        ...LOC,
        actor: { type: 'string', enum: ['me', 'agent', 'api_key', 'mcp', 'agency_key', 'user', 'app', 'all'] },
        entity: { type: 'string', description: 'Art, z. B. task, contact, deal, company, appointment, workflow' },
        query: { type: 'string', description: 'Suchtext im Eintrag' },
        trash: { type: 'boolean', description: 'Nur gelöschte Datensätze (Papierkorb)' },
        include_undone: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      ['location_id'],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      const actor = a.actor && a.actor !== 'me' ? a.actor : 'me';
      const r = await call.api('GET', `${a.trash ? '/api/undo/trash' : '/api/undo'}${q({ actor: a.trash ? undefined : actor, scope: actor === 'me' ? 'mine' : 'all', entity: a.entity, q: a.query, include: a.include_undone ? 'undone' : '', limit: a.limit ?? 25 })}`, { location: a.location_id });
      return {
        retention_days: r.retention_days,
        changes: (r.items as any[]).map((i) => ({
          id: i.id,
          at: i.at,
          label: i.label,
          actor: i.actor,
          actor_kind: i.actor_kind,
          action: i.action,
          entity: i.entity,
          entity_id: i.entity_id,
          count: i.count,
          changes: i.changes,
          notice: i.notice || undefined,
          can_undo: i.can_undo,
          undone: !!i.undone_at,
          is_undo: i.kind === 'undo',
          expires_at: i.removes ? i.expires_at : undefined,
        })),
      };
    },
  },
  {
    name: 'ghl_undo',
    title: 'Änderung rückgängig machen',
    description:
      'Stellt den Zustand vor einer Änderung wieder her (id aus ghl_undo_list). Ein Bulk-Eintrag wird als Ganzes zurückgenommen. Wurde der Datensatz seitdem erneut geändert, passiert nichts und die Antwort enthält conflict:true mit der Differenz – erst mit force:true überschreiben. Bereits Gesendetes (E-Mail, SMS, Zahlungen, Anzeigen) lässt sich nicht zurückholen: nur die Daten werden zurückgesetzt, notices sagt was.',
    inputSchema: obj({ ...LOC, entry_id: { type: 'string' }, force: { type: 'boolean', description: 'Trotz späterer Änderung überschreiben' }, single: { type: 'boolean', description: 'Nur diesen Eintrag, nicht die ganze Gruppe' } }, ['location_id', 'entry_id']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async (call, a) => {
      const id = encodeURIComponent(a.entry_id);
      if (!a.force) {
        const p = await call.api('GET', `/api/undo/${id}/preview${q({ single: a.single ? '1' : '' })}`, { location: a.location_id });
        if (p.conflict) return { restored: false, conflict: true, message: `„${p.label}“ wurde seit dieser Änderung erneut geändert – mit force:true trotzdem wiederherstellen.`, diff: p.conflicts.flatMap((c: any) => c.diff), notice: p.notice || undefined };
      }
      const r = await call.api('POST', `/api/undo/${id}`, { location: a.location_id, body: { force: a.force === true, single: a.single === true } });
      return { restored: true, label: r.label, notices: r.notices, redo_id: r.redo_id };
    },
  },
];

export const undoToolsModule: Module = {
  name: 'undo-tools',
  register(app) {
    const { router } = app;
    const journal = app.services.undo as Journal;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    const relay = (ctx: Ctx) => {
      ctx.skipAfterWrite = true;
    };

    /** My recent changes across the sub-accounts I can open (or `?location=<id>`), newest first – the data of an undo snackbar. */
    router.get('/api/mobile/undo/recent', 'user', (ctx) => {
      const limit = clampLimit(ctx.query.get('limit'), 20, 100);
      const want = ctx.query.get('location');
      const locs = visibleLocations(app, ctx).filter((l) => !want || want === 'all' || l.id === want);
      const out: any[] = [];
      for (const l of locs) {
        const sub: Ctx = { ...ctx, locationId: l.id };
        const q = new URLSearchParams({ limit: String(limit) });
        const r = journal.list(sub, q);
        for (const i of r.items) out.push({ ...i, location_id: l.id, location_name: l.name });
      }
      out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      return { items: out.slice(0, limit), server_time: new Date().toISOString() };
    });

    /** Undo one entry (a 409 carries `conflict` and the `diff`; send `{force: true}` to overwrite). */
    router.post('/api/mobile/undo/:id', 'user', async (ctx) => {
      relay(ctx);
      const id = String(ctx.params.id);
      const loc = ownLocation(app, ctx, 'undo_entries', id, 'Eintrag nicht gefunden');
      const b = ctx.body ?? {};
      if (b.force !== undefined && typeof b.force !== 'boolean') throw bad('force: true oder false');
      return callRoute(app, ctx, 'POST', `/api/undo/${encodeURIComponent(id)}`, { locationId: loc.id, body: { force: b.force === true, single: b.single === true } });
    });
  },
};
