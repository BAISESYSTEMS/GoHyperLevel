import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, str } from '../core/http.js';
import { id, now } from '../core/util.js';
import { callRoute } from '../services/route-call.js';
import type { SnapshotPart } from '../services/snapshots.js';
import type { Tool } from './mcp.js';

/**
 * Folders and bulk actions for the workflow list (docs/workflow-actions.md#folders-and-bulk-actions): nested folders per
 * sub-account (`workflow_folders`, `workflows.folder_id`), and one route that moves, activates, pauses, drafts or deletes several
 * workflows. Status changes and deletes run through the normal routes (`PATCH`/`DELETE /api/workflows/:id`), so the check before
 * activating, versions and the undo journal apply to each one exactly as if done by hand; a workflow that fails its check is
 * reported, the others go on. Folders travel in snapshots (part `workflow_folders`, by name).
 */

const MAX_DEPTH = 5;
const ACTIONS = ['move', 'activate', 'pause', 'draft', 'delete'] as const;
type Action = (typeof ACTIONS)[number];
type Folder = { id: string; name: string; parent_id: string | null; position: number };

const bodyIds = (body: any): string[] => (Array.isArray(body?.ids) ? [...new Set<string>(body.ids.map(String))].filter(Boolean).slice(0, 200) : []);

const TOOLS: Tool[] = [
  {
    name: 'ghl_workflow_folders',
    title: 'Workflow-Ordner auflisten',
    description: 'Ordner der Workflows (verschachtelt über parent_id) mit Anzahl Workflows; ghl_workflow_bulk verschiebt Workflows hinein.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', '/api/workflow-folders', { location: a.location_id }),
  },
  {
    name: 'ghl_workflow_bulk',
    title: 'Mehrere Workflows verschieben, aktivieren, pausieren, löschen',
    description:
      'Massenaktion für Workflows (IDs aus der Workflow-Liste). action: move (folder_id oder leer = ohne Ordner; folder_name legt den Ordner bei Bedarf an), activate, pause, draft, delete. Aktivieren prüft jeden Workflow wie von Hand; was die Prüfung nicht besteht, steht in failed. Jede Änderung ist rückgängig machbar.',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string' },
        action: { type: 'string', enum: [...ACTIONS] },
        ids: { type: 'array', items: { type: 'string' } },
        folder_id: { type: 'string' },
        folder_name: { type: 'string' },
      },
      required: ['action', 'ids'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    klassFor: (a) => (a.action === 'delete' || a.action === 'activate' ? 'sensitive' : 'write'),
    run: async (call, a) => {
      let folder = a.folder_id as string | undefined;
      if (!folder && a.folder_name) {
        const list: Folder[] = await call.api('GET', '/api/workflow-folders', { location: a.location_id });
        folder = list.find((f) => f.name.toLowerCase() === String(a.folder_name).toLowerCase())?.id ?? (await call.api('POST', '/api/workflow-folders', { location: a.location_id, body: { name: a.folder_name } })).id;
      }
      return call.api('POST', '/api/workflows/bulk', { location: a.location_id, body: { action: a.action, ids: a.ids, folder_id: folder ?? null } });
    },
  },
];

/** The chain of parents of a folder (cycle-safe). */
function ancestors(folders: Map<string, Folder>, start: string | null): string[] {
  const out: string[] = [];
  let cur = start;
  while (cur && !out.includes(cur) && out.length < 50) {
    out.push(cur);
    cur = folders.get(cur)?.parent_id ?? null;
  }
  return out;
}

export const workflowFoldersModule: Module = {
  name: 'workflow-folders',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE workflow_folders (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, parent_id TEXT REFERENCES workflow_folders(id) ON DELETE SET NULL,
        position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE INDEX workflow_folders_location ON workflow_folders(location_id);
      ALTER TABLE workflows ADD COLUMN folder_id TEXT REFERENCES workflow_folders(id) ON DELETE SET NULL;
      CREATE INDEX workflows_folder ON workflows(folder_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    const foldersOf = (loc: string) => new Map(db.all<Folder>('SELECT id, name, parent_id, position FROM workflow_folders WHERE location_id = ? ORDER BY position, name', loc).map((f) => [f.id, f]));
    const folder = (loc: string, fid: string) => db.get<Folder>('SELECT id, name, parent_id, position FROM workflow_folders WHERE id = ? AND location_id = ?', fid, loc);
    const parentOk = (loc: string, self: string | null, parent: string | null) => {
      if (!parent) return null;
      const all = foldersOf(loc);
      if (!all.has(parent)) throw bad('Übergeordneter Ordner nicht gefunden');
      const chain = ancestors(all, parent);
      if (self && chain.includes(self)) throw bad('Ein Ordner kann nicht in sich selbst liegen');
      if (chain.length >= MAX_DEPTH) throw bad(`Höchstens ${MAX_DEPTH} Ebenen`);
      return parent;
    };

    router.get('/api/workflow-folders', 'location', (ctx) =>
      db.all(
        `SELECT f.id, f.name, f.parent_id, f.position, (SELECT COUNT(*) FROM workflows w WHERE w.folder_id = f.id) AS workflows
         FROM workflow_folders f WHERE f.location_id = ? ORDER BY f.position, f.name`,
        ctx.locationId,
      ),
    );
    router.post('/api/workflow-folders', 'location', (ctx) => {
      const name = str(ctx.body?.name, 'Name', { required: true, max: 80 });
      const parent = parentOk(ctx.locationId, null, ctx.body?.parent_id ? String(ctx.body.parent_id) : null);
      if (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM workflow_folders WHERE location_id = ?', ctx.locationId)!.n >= 300) throw bad('Höchstens 300 Ordner');
      const pos = db.get<{ p: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM workflow_folders WHERE location_id = ?', ctx.locationId)!.p;
      const row = { id: id(), location_id: ctx.locationId, name, parent_id: parent, position: pos, created_at: now() };
      db.insert('workflow_folders', row);
      return { ...row, workflows: 0 };
    });
    router.patch('/api/workflow-folders/:id', 'location', (ctx) => {
      const f = folder(ctx.locationId, ctx.params.id);
      if (!f) throw notFound('Ordner nicht gefunden');
      const patch: Record<string, unknown> = {};
      if (ctx.body?.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true, max: 80 });
      if (ctx.body?.parent_id !== undefined) patch.parent_id = parentOk(ctx.locationId, f.id, ctx.body.parent_id ? String(ctx.body.parent_id) : null);
      if (ctx.body?.position !== undefined) patch.position = Math.max(0, Math.min(10_000, Math.round(Number(ctx.body.position) || 0)));
      if (Object.keys(patch).length) db.update('workflow_folders', f.id, patch, ctx.locationId);
      return folder(ctx.locationId, f.id);
    });
    // Deleting a folder keeps its workflows and sub-folders: they move up to the folder's parent.
    router.delete('/api/workflow-folders/:id', 'location', (ctx) => {
      const f = folder(ctx.locationId, ctx.params.id);
      if (!f) throw notFound('Ordner nicht gefunden');
      db.tx(() => {
        db.run('UPDATE workflows SET folder_id = ? WHERE folder_id = ? AND location_id = ?', f.parent_id, f.id, ctx.locationId);
        db.run('UPDATE workflow_folders SET parent_id = ? WHERE parent_id = ? AND location_id = ?', f.parent_id, f.id, ctx.locationId);
        db.run('DELETE FROM workflow_folders WHERE id = ?', f.id);
      });
      return { ok: true };
    });

    router.post('/api/workflows/bulk', 'location', async (ctx) => {
      const action = String(ctx.body?.action ?? '') as Action;
      if (!ACTIONS.includes(action)) throw bad(`Unbekannte Aktion (${ACTIONS.join(', ')})`);
      const ids = bodyIds(ctx.body);
      if (!ids.length) throw bad('ids: die gewählten Workflows angeben');
      const own = db.all<{ id: string; name: string }>(`SELECT id, name FROM workflows WHERE location_id = ? AND id IN (${ids.map(() => '?').join(',')})`, ctx.locationId, ...ids);
      if (own.length !== ids.length) throw bad('Unbekannter Workflow');
      if (action === 'move') {
        const fid = ctx.body?.folder_id ? String(ctx.body.folder_id) : null;
        if (fid && !folder(ctx.locationId, fid)) throw bad('Ordner nicht gefunden');
        const n = db.run(`UPDATE workflows SET folder_id = ? WHERE location_id = ? AND id IN (${ids.map(() => '?').join(',')})`, fid, ctx.locationId, ...ids).changes;
        return { count: n, failed: [] };
      }
      // Status and delete: through the normal routes, one by one (check, versions, undo, audit).
      const failed: { id: string; name: string; error: string }[] = [];
      let count = 0;
      for (const w of own) {
        try {
          if (action === 'delete') await callRoute(app, ctx, 'DELETE', `/api/workflows/${encodeURIComponent(w.id)}`);
          else await callRoute(app, ctx, 'PATCH', `/api/workflows/${encodeURIComponent(w.id)}`, { status: action === 'activate' ? 'active' : action === 'pause' ? 'paused' : 'draft' });
          count++;
        } catch (e) {
          failed.push({ id: w.id, name: w.name, error: e instanceof HttpError || e instanceof Error ? e.message : String(e) });
        }
      }
      return { count, failed };
    });

    // --- snapshots: folders by name, and which workflow sits where (matched by workflow name on apply) -------------------------
    const part: SnapshotPart = {
      key: 'workflow_folders',
      export: (_a: App, loc: string, only?: unknown) => {
        if (only) return [];
        const all = foldersOf(loc);
        const path = (fid: string | null) => ancestors(all, fid).reverse().map((x) => all.get(x)!.name);
        return [
          ...[...all.values()].map((f) => ({ type: 'folder', path: path(f.id) })),
          ...db.all<{ name: string; folder_id: string }>('SELECT name, folder_id FROM workflows WHERE location_id = ? AND folder_id IS NOT NULL', loc).map((w) => ({ type: 'workflow', name: w.name, path: path(w.folder_id) })),
        ];
      },
      apply: (_a: App, loc: string, items: Record<string, unknown>[], c: any) => {
        const byPath = new Map<string, string>();
        const ensure = (path: string[]): string | null => {
          let parent: string | null = null;
          for (let i = 0; i < Math.min(path.length, MAX_DEPTH); i++) {
            const key = JSON.stringify(path.slice(0, i + 1));
            let fid = byPath.get(key);
            if (!fid) {
              const name = String(path[i]).slice(0, 80);
              fid = db.get<{ id: string }>(`SELECT id FROM workflow_folders WHERE location_id = ? AND name = ? AND parent_id IS ?`, loc, name, parent)?.id;
              if (!fid) {
                fid = id();
                db.insert('workflow_folders', { id: fid, location_id: loc, name, parent_id: parent, position: 0, created_at: now() });
              }
              byPath.set(key, fid);
            }
            parent = fid;
          }
          return parent;
        };
        let n = 0;
        for (const it of items ?? []) {
          const path = Array.isArray(it.path) ? (it.path as unknown[]).map(String).filter(Boolean) : [];
          if (!path.length) continue;
          const fid = ensure(path);
          if (it.type === 'workflow' && fid) {
            const w = db.get<{ id: string }>('SELECT id FROM workflows WHERE location_id = ? AND name = ? AND folder_id IS NULL ORDER BY created_at DESC LIMIT 1', loc, String(it.name ?? ''));
            if (w) db.run('UPDATE workflows SET folder_id = ? WHERE id = ?', fid, w.id);
          }
          n++;
        }
        if (c?.created) c.created.workflow_folders = n;
      },
    };
    app.services.snapshotParts = [...(app.services.snapshotParts ?? []), part];
  },
};
