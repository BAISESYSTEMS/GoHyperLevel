import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str } from '../core/http.js';
import { id, now } from '../core/util.js';
import type { SnapshotPart } from '../services/snapshots.js';
import { applyTagMeta, cleanColor, exportTagMeta } from '../services/tag-meta.js';
import { tableEntity } from '../services/undo-table.js';

/**
 * Tag colours and categories (docs/api.md#tags-colours-and-categories): a colour per tag (chips everywhere tags show use it,
 * web/src/tag-chip.tsx), categories with their own colour to group the tags in the settings. Both travel in snapshots
 * (part `tag_meta`) and are covered by the undo journal (category edits and deletes, a tag's colour/category).
 */

const asHttp = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw bad((e as Error).message);
  }
};

export const tagMetaModule: Module = {
  name: 'tag-meta',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE tag_categories (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        UNIQUE(location_id, name)
      );
      ALTER TABLE tags ADD COLUMN color TEXT NOT NULL DEFAULT '';
      ALTER TABLE tags ADD COLUMN category_id TEXT REFERENCES tag_categories(id) ON DELETE SET NULL;
      CREATE INDEX tags_category ON tags(category_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const category = (locationId: string, cid: string) => db.get('SELECT * FROM tag_categories WHERE id = ? AND location_id = ?', cid, locationId);

    // Colours and categories of every tag, for chips and pickers (readable by everyone in the sub-account, like the tag list).
    router.get('/api/tags/meta', 'location', (ctx) => ({
      tags: db.all('SELECT id, name, color, category_id FROM tags WHERE location_id = ? ORDER BY name', ctx.locationId),
      categories: db.all('SELECT id, name, color, position FROM tag_categories WHERE location_id = ? ORDER BY position, name', ctx.locationId),
    }));
    router.patch('/api/tags/:id', 'location', (ctx) => {
      const t = db.get('SELECT * FROM tags WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!t) throw notFound('Tag nicht gefunden');
      const patch: Record<string, unknown> = {};
      if (ctx.body.color !== undefined) patch.color = asHttp(() => cleanColor(ctx.body.color));
      if (ctx.body.category_id !== undefined) {
        const cid = ctx.body.category_id ? String(ctx.body.category_id) : null;
        if (cid && !category(ctx.locationId, cid)) throw bad('Kategorie nicht gefunden');
        patch.category_id = cid;
      }
      if (Object.keys(patch).length) db.update('tags', t.id, patch, ctx.locationId);
      return db.get('SELECT id, name, color, category_id FROM tags WHERE id = ?', t.id);
    });

    router.get('/api/tag-categories', 'location', (ctx) =>
      db.all(
        `SELECT c.*, (SELECT COUNT(*) FROM tags t WHERE t.category_id = c.id) AS tag_count FROM tag_categories c WHERE c.location_id = ? ORDER BY c.position, c.name`,
        ctx.locationId,
      ),
    );
    router.post('/api/tag-categories', 'location', (ctx) => {
      const name = str(ctx.body.name, 'Name', { required: true, max: 60 });
      if (db.get('SELECT 1 AS x FROM tag_categories WHERE location_id = ? AND name = ?', ctx.locationId, name)) throw bad('Eine Kategorie mit diesem Namen gibt es schon');
      if (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tag_categories WHERE location_id = ?', ctx.locationId)!.n >= 200) throw bad('Höchstens 200 Kategorien');
      const pos = db.get<{ p: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM tag_categories WHERE location_id = ?', ctx.locationId)!.p;
      const row = { id: id(), location_id: ctx.locationId, name, color: asHttp(() => cleanColor(ctx.body.color)), position: pos, created_at: now() };
      db.insert('tag_categories', row);
      return row;
    });
    router.patch('/api/tag-categories/:id', 'location', (ctx) => {
      const c = category(ctx.locationId, ctx.params.id);
      if (!c) throw notFound('Kategorie nicht gefunden');
      const patch: Record<string, unknown> = {};
      if (ctx.body.name !== undefined) {
        patch.name = str(ctx.body.name, 'Name', { required: true, max: 60 });
        if (db.get('SELECT 1 AS x FROM tag_categories WHERE location_id = ? AND name = ? AND id != ?', ctx.locationId, patch.name as string, c.id)) throw bad('Eine Kategorie mit diesem Namen gibt es schon');
      }
      if (ctx.body.color !== undefined) patch.color = asHttp(() => cleanColor(ctx.body.color));
      if (ctx.body.position !== undefined) patch.position = Math.max(0, Math.min(10_000, Math.round(Number(ctx.body.position) || 0)));
      if (Object.keys(patch).length) db.update('tag_categories', c.id, patch, ctx.locationId);
      return category(ctx.locationId, c.id);
    });
    // The tags stay; they only lose the category (ON DELETE SET NULL – the undo entry puts them back in).
    router.delete('/api/tag-categories/:id', 'location', (ctx) => {
      if (!db.run('DELETE FROM tag_categories WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId).changes) throw notFound('Kategorie nicht gefunden');
      return { ok: true };
    });

    // --- snapshots ------------------------------------------------------------------------------------------------------
    const part: SnapshotPart = {
      key: 'tag_meta',
      export: (_app, loc, only) => (only ? [] : exportTagMeta(app, loc) as unknown as Record<string, unknown>[]),
      apply: (_app, loc, items, c) => {
        c.created.tag_meta = applyTagMeta(app, loc, items);
      },
    };
    app.services.snapshotParts = [...(app.services.snapshotParts ?? []), part];

    // --- undo -----------------------------------------------------------------------------------------------------------
    const undo = app.services.undo as { register(type: string, e: unknown): void; track(rule: unknown): void } | undefined;
    if (undo) {
      undo.register(
        'tag_category',
        tableEntity(app, {
          noun: 'Tag-Kategorie',
          plural: 'Tag-Kategorien',
          area: 'settings',
          table: 'tag_categories',
          title: (r) => String(r.name),
          contactCol: null,
          fields: { name: { label: 'Name' }, color: { label: 'Farbe' }, position: { label: 'Reihenfolge' } },
        }),
      );
      undo.track({ method: 'PATCH', pattern: '/api/tag-categories/:id', entity: 'tag_category' });
      undo.track({ method: 'DELETE', pattern: '/api/tag-categories/:id', entity: 'tag_category' });
      undo.track({ method: 'PATCH', pattern: '/api/tags/:id', entity: 'tag' });
    }
  },
};
