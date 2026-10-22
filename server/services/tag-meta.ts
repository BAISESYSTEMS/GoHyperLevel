import type { App } from '../core/app.js';
import { ensureTags } from './contacts.js';
import { id, now } from '../core/util.js';

/**
 * Tag colours and categories (modules/tag-meta.ts): pure helpers plus the snapshot copy. A tag keeps its name as the key on
 * contacts (`contacts.tags` is a JSON list of names); colour and category live on the `tags` row, categories in
 * `tag_categories`. A tag without its own colour shows the colour of its category.
 */

/** `#rrggbb` (lower case) or '' for "no colour"; anything else is an error. */
export function cleanColor(v: unknown, field = 'Farbe'): string {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v).trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(s)) throw new Error(`${field}: Farbe als #rrggbb angeben`);
  return s;
}

export interface TagMetaItem {
  type: 'category' | 'tag';
  name: string;
  color: string;
  position?: number;
  /** tags: the category's name (ids are not portable). */
  category?: string;
}

/** What a snapshot carries: every category, and every tag that has a colour or a category. */
export function exportTagMeta(app: App, locationId: string): TagMetaItem[] {
  const cats = app.db.all<{ id: string; name: string; color: string; position: number }>('SELECT id, name, color, position FROM tag_categories WHERE location_id = ? ORDER BY position, name', locationId);
  const byId = new Map(cats.map((c) => [c.id, c.name]));
  const tags = app.db.all<{ name: string; color: string; category_id: string | null }>(`SELECT name, color, category_id FROM tags WHERE location_id = ? AND (color != '' OR category_id IS NOT NULL) ORDER BY name`, locationId);
  return [
    ...cats.map((c) => ({ type: 'category' as const, name: c.name, color: c.color, position: c.position })),
    ...tags.map((t) => ({ type: 'tag' as const, name: t.name, color: t.color, ...(t.category_id && byId.has(t.category_id) ? { category: byId.get(t.category_id) } : {}) })),
  ];
}

/** Applies a snapshot's tag meta: categories by name (existing ones keep their id), then the tags' colour and category. */
export function applyTagMeta(app: App, locationId: string, items: unknown[]): number {
  const { db } = app;
  const safe = (v: unknown) => {
    try {
      return cleanColor(v);
    } catch {
      return '';
    }
  };
  let n = 0;
  const list = items.filter((x): x is TagMetaItem => !!x && typeof x === 'object' && typeof (x as TagMetaItem).name === 'string' && !!(x as TagMetaItem).name.trim()).slice(0, 2000);
  for (const c of list.filter((x) => x.type === 'category').slice(0, 200)) {
    const name = c.name.trim().slice(0, 60);
    db.run('INSERT OR IGNORE INTO tag_categories (id, location_id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?)', id(), locationId, name, safe(c.color), Number(c.position) || 0, now());
    db.run('UPDATE tag_categories SET color = ? WHERE location_id = ? AND name = ?', safe(c.color), locationId, name);
    n++;
  }
  const cats = new Map(db.all<{ id: string; name: string }>('SELECT id, name FROM tag_categories WHERE location_id = ?', locationId).map((c) => [c.name, c.id]));
  const tags = list.filter((x) => x.type === 'tag');
  ensureTags(app, locationId, tags.map((t) => t.name.trim().slice(0, 80)));
  for (const t of tags) {
    db.run('UPDATE tags SET color = ?, category_id = ? WHERE location_id = ? AND name = ?', safe(t.color), (t.category && cats.get(String(t.category).trim())) || null, locationId, t.name.trim().slice(0, 80));
    n++;
  }
  return n;
}
