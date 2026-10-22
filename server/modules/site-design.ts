import type { App, Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { tokenContrast } from '../services/site-a11y.js';
import { siteBlocks } from '../services/site-blocks.js';
import { cleanBlocks, walkBlocks } from '../services/site-layout.js';
import { COLOR_TOKENS, DEFAULT_TOKENS, FONT_STACKS, tokensOf } from '../services/site-style.js';

/**
 * Design system of a site and reusable components.
 *  - `GET /api/funnels/:id/design`: the tokens in effect (brand colours, type scale, radius, shadows, fonts), the defaults, the font
 *    stacks, the contrast check of the palette. Tokens, header, footer, menus, languages and the 404 page are stored in the site's
 *    settings (PATCH /api/funnels/:id, validated by services/site-settings.ts).
 *  - Components ("Symbole"): a block tree saved once and placed on any page of the sub-account as `{type:'component', component_id}`.
 *    Changing the component changes every page that uses it; deleting one turns the places it was used into plain blocks first.
 */

const MAX_DEPTH = 3;

export const siteDesignModule: Module = {
  name: 'site-design',
  migrations: [
    [
      '001-components',
      `
      CREATE TABLE site_components (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, blocks TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX site_components_loc ON site_components(location_id);
      `,
    ],
  ],
  register(app: App) {
    const { db, router } = app;
    const writable = (ctx: Ctx) => {
      if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
    };
    const getComp = (loc: string, cid: string) => parseJson(db.get('SELECT * FROM site_components WHERE id = ? AND location_id = ?', cid, loc), ['blocks']);

    /** Pages that place a component (the editor warns before a delete and shows "Verwendet auf …"). */
    function usage(loc: string, cid: string): { id: string; name: string; funnel_id: string }[] {
      const rows = db.all('SELECT id, name, funnel_id, blocks FROM funnel_pages WHERE location_id = ? AND blocks LIKE ?', loc, `%"component_id":"${cid}"%`);
      return rows.filter((r) => {
        let found = false;
        walkBlocks(JSON.parse(r.blocks || '[]'), (b) => {
          if (b.type === 'component' && b.component_id === cid) found = true;
        });
        return found;
      }).map((r) => ({ id: r.id, name: r.name, funnel_id: r.funnel_id }));
    }

    /** `component` blocks: the saved blocks are rendered in place (an instance inside itself, or deeper than 3 levels, is cut off). */
    siteBlocks(app).set('component', {
      type: 'component',
      render: (env, b, o) => {
        const cid = String(b.component_id ?? '');
        if (!cid || env.trail.includes(cid) || env.trail.length >= MAX_DEPTH) return '';
        const c = getComp(env.locationId, cid);
        if (!c || !Array.isArray(c.blocks)) return env.preview ? '<div class="blk" style="padding:20px;text-align:center;color:#9ca3af">Komponente nicht gefunden</div>' : '';
        env.trail.push(cid);
        try {
          return env.render(c.blocks, { bare: o.bare });
        } finally {
          env.trail.pop();
        }
      },
    });

    // --- design ----------------------------------------------------------------------------------------------------------------
    router.get('/api/funnels/:id/design', 'location', (ctx) => {
      const f = parseJson(db.get('SELECT * FROM funnels WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId), ['settings']);
      if (!f) throw notFound('Website nicht gefunden');
      const tokens = tokensOf(f.settings);
      return {
        tokens,
        defaults: DEFAULT_TOKENS,
        color_names: COLOR_TOKENS,
        fonts: Object.entries(FONT_STACKS).map(([key, v]) => ({ key, label: v.label, css: v.css })),
        contrast: tokenContrast(tokens),
        header: f.settings.header ?? null,
        footer: f.settings.footer ?? null,
        menus: f.settings.menus ?? {},
        languages: f.settings.languages ?? null,
        not_found: f.settings.not_found ?? null,
        search: f.settings.search ?? { enabled: false },
        pages: db.all('SELECT id, name, slug FROM funnel_pages WHERE funnel_id = ? ORDER BY position, created_at', f.id),
      };
    });

    // --- components ------------------------------------------------------------------------------------------------------------
    const out = (c: any, withBlocks = true) => ({ id: c.id, name: c.name, created_at: c.created_at, updated_at: c.updated_at, ...(withBlocks ? { blocks: c.blocks } : {}) });

    router.get('/api/site-components', 'location', (ctx) => {
      const rows = parseRows(db.all('SELECT * FROM site_components WHERE location_id = ? ORDER BY name COLLATE NOCASE', ctx.locationId), ['blocks']);
      return rows.map((c) => ({ ...out(c, ctx.query.get('blocks') === '1'), uses: usage(ctx.locationId, c.id).length, blocks_count: Array.isArray(c.blocks) ? c.blocks.length : 0 }));
    });
    router.post('/api/site-components', 'location', (ctx) => {
      writable(ctx);
      const name = str(ctx.body?.name, 'Name', { required: true, max: 80 });
      const blocks = cleanBlocks(ctx.body?.blocks);
      if (!blocks.length) throw bad('Eine Komponente braucht mindestens einen Block');
      if (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM site_components WHERE location_id = ?', ctx.locationId)!.n >= 200) throw bad('Höchstens 200 Komponenten');
      const row = { id: id(), location_id: ctx.locationId, name, blocks: refresh(blocks), created_at: now(), updated_at: now() };
      db.insert('site_components', row);
      return out(row);
    });
    router.get('/api/site-components/:id', 'location', (ctx) => {
      const c = getComp(ctx.locationId, ctx.params.id);
      if (!c) throw notFound('Komponente nicht gefunden');
      return { ...out(c), used_on: usage(ctx.locationId, c.id) };
    });
    router.patch('/api/site-components/:id', 'location', (ctx) => {
      writable(ctx);
      const c = getComp(ctx.locationId, ctx.params.id);
      if (!c) throw notFound('Komponente nicht gefunden');
      const patch: Record<string, any> = { updated_at: now() };
      if (ctx.body?.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true, max: 80 });
      if (ctx.body?.blocks !== undefined) {
        const blocks = cleanBlocks(ctx.body.blocks);
        if (!blocks.length) throw bad('Eine Komponente braucht mindestens einen Block');
        // A component must not contain itself, directly or through another component.
        if (reaches(ctx.locationId, blocks, c.id)) throw bad('Eine Komponente kann sich nicht selbst enthalten');
        patch.blocks = blocks;
      }
      db.update('site_components', c.id, patch);
      // Pages using it show the change at once; the funnels' "updated" time moves so caches and copies notice.
      for (const u of usage(ctx.locationId, c.id)) db.run('UPDATE funnels SET updated_at = ? WHERE id = ?', now(), u.funnel_id);
      return out(getComp(ctx.locationId, c.id));
    });
    /** Deleting a component keeps the pages as they look: every place becomes plain blocks (copies with new ids). */
    router.delete('/api/site-components/:id', 'location', (ctx) => {
      writable(ctx);
      const c = getComp(ctx.locationId, ctx.params.id);
      if (!c) throw notFound('Komponente nicht gefunden');
      let detached = 0;
      db.tx(() => {
        for (const u of usage(ctx.locationId, c.id)) {
          const p = parseJson(db.get('SELECT * FROM funnel_pages WHERE id = ?', u.id), ['blocks']);
          if (!p) continue;
          detached++;
          db.update('funnel_pages', p.id, { blocks: detach(p.blocks, c), updated_at: now() });
        }
        db.run('DELETE FROM site_components WHERE id = ?', c.id);
      });
      return { ok: true, detached };
    });

    /** New ids for a tree of blocks (a component's blocks are inserted as copies, never shared). */
    function refresh(blocks: any): any {
      return JSON.parse(JSON.stringify(blocks), (k, v) => (k === 'id' && typeof v === 'string' ? id(8) : v));
    }
    function detach(blocks: any[], c: any): any[] {
      const walk = (list: any[]): any[] => {
        const res: any[] = [];
        for (const b of list) {
          if (b?.type === 'component' && b.component_id === c.id) res.push(...refresh(c.blocks));
          else if (b?.type === 'section') res.push({ ...b, rows: (b.rows ?? []).map((r: any) => ({ ...r, cols: (r.cols ?? []).map((col: any) => ({ ...col, blocks: walk(col.blocks ?? []) })) })) });
          else res.push(b);
        }
        return res;
      };
      return walk(blocks);
    }
    /** Does a tree reach `target` through component references? (cycle check, depth-limited) */
    function reaches(loc: string, blocks: any[], target: string, depth = 0): boolean {
      let hit = false;
      walkBlocks(blocks, (b) => {
        if (hit || b.type !== 'component') return;
        if (b.component_id === target) hit = true;
        else if (depth < 6) {
          const c = getComp(loc, String(b.component_id ?? ''));
          if (c && reaches(loc, c.blocks, target, depth + 1)) hit = true;
        }
      });
      return hit;
    }
  },
};
