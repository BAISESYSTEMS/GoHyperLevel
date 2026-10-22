import type { App, Module } from '../core/app.js';
import { HttpError, bad, type Ctx } from '../core/http.js';
import { now } from '../core/util.js';
import { loadBoard as loadLivingBoard } from '../services/boards-store.js';
import { parseSpec } from '../services/boards-model.js';
import { loadBoard as loadCanvasBoard } from '../services/canvas-store.js';
import { XR_LIMITS, cleanBoardLayout, cleanCanvasLayout, cleanWorkspace, defaultWorkspace } from '../services/xr-model.js';

/**
 * XR: the per-person layouts behind the Raum-Modus extras (docs/xr.md).
 *
 *   GET / PUT / DELETE /api/boards/:id/xr-layout   where I hung the widgets of a Living Board in my headset
 *   GET / PUT / DELETE /api/canvas/:id/xr-layout   where I hung the plane of a Canvas board
 *   GET / PUT / DELETE /api/xr/workspace           my Arbeitsfläche: pages side by side with their widths
 *
 * A layout belongs to ONE person and never changes the board or the canvas: a viewer without edit rights arranges
 * their own view, nobody sees anybody else's. The board and canvas routes sit under the prefixes `/api/boards` and
 * `/api/canvas`, so the area rules of permissions.ts (Dashboard, Canvas) apply without an entry of their own, and the
 * subject goes through the same access check as the board itself (404 without access, never a hint it exists).
 * Keys and MCP connections have no person to keep a layout for: they are refused.
 */

type Kind = 'board' | 'canvas' | 'workspace';

export const xrModule: Module = {
  name: 'xr',
  migrations: [
    [
      '001-init',
      `CREATE TABLE xr_layouts (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        subject_id TEXT NOT NULL DEFAULT '',
        location_id TEXT REFERENCES locations(id) ON DELETE CASCADE,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, kind, subject_id)
      );
      CREATE INDEX xr_layouts_subject ON xr_layouts(kind, subject_id);`,
    ],
  ],
  register(app: App) {
    const { db, router } = app;

    /** The signed-in person; keys, MCP connections and read-only connections have no layout of their own to change. */
    const person = (ctx: Ctx, mutating = false) => {
      if (!ctx.user || ctx.via === 'agency_key' || ctx.via === 'api_key' || ctx.via === 'mcp') throw new HttpError(403, 'Das geht nur mit persönlicher Anmeldung');
      if (mutating && ctx.scope === 'read') throw new HttpError(403, 'Diese Verbindung darf nur lesen');
      return ctx.user;
    };

    const read = (userId: string, kind: Kind, subject: string): { layout: unknown; updated_at: string } | null => {
      const row = db.get<{ data: string; updated_at: string }>('SELECT data, updated_at FROM xr_layouts WHERE user_id = ? AND kind = ? AND subject_id = ?', userId, kind, subject);
      if (!row) return null;
      try {
        return { layout: JSON.parse(row.data), updated_at: row.updated_at };
      } catch {
        return null;
      }
    };
    const write = (userId: string, kind: Kind, subject: string, locationId: string | null, layout: unknown) => {
      const at = now();
      db.run(
        `INSERT INTO xr_layouts (user_id, kind, subject_id, location_id, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, kind, subject_id) DO UPDATE SET data = excluded.data, location_id = excluded.location_id, updated_at = excluded.updated_at`,
        userId,
        kind,
        subject,
        locationId,
        JSON.stringify(layout),
        at,
      );
      // Everybody keeps a bounded number: the oldest go first.
      const n = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM xr_layouts WHERE user_id = ?', userId)!.n;
      if (n > XR_LIMITS.perUser)
        db.run(
          `DELETE FROM xr_layouts WHERE rowid IN (SELECT rowid FROM xr_layouts WHERE user_id = ? ORDER BY updated_at ASC LIMIT ?)`,
          userId,
          n - XR_LIMITS.perUser,
        );
      return at;
    };
    const drop = (userId: string, kind: Kind, subject: string) => db.run('DELETE FROM xr_layouts WHERE user_id = ? AND kind = ? AND subject_id = ?', userId, kind, subject);
    /** A stored layout that no longer validates (an older shape) reads as "none" – the client falls back to its default. */
    const tolerant = <T>(fn: () => T): T | null => {
      try {
        return fn();
      } catch {
        return null;
      }
    };
    const checked = <T>(fn: () => T): T => {
      try {
        return fn();
      } catch (e) {
        throw bad((e as Error).message);
      }
    };

    // --- Living Boards -----------------------------------------------------------------------------------------
    router.get('/api/boards/:id/xr-layout', 'location', (ctx) => {
      const u = person(ctx);
      const { board } = loadLivingBoard(app, ctx, ctx.params.id);
      const r = read(u.id, 'board', board.id);
      return { layout: r ? tolerant(() => cleanBoardLayout(r.layout, parseSpec(board.spec).widgets.map((w) => w.id))) : null, updated_at: r?.updated_at ?? null };
    });
    router.put('/api/boards/:id/xr-layout', 'location', (ctx) => {
      const u = person(ctx, true);
      const { board } = loadLivingBoard(app, ctx, ctx.params.id);
      const layout = checked(() => cleanBoardLayout(ctx.body?.layout, parseSpec(board.spec).widgets.map((w) => w.id)));
      return { layout, updated_at: write(u.id, 'board', board.id, board.location_id, layout) };
    });
    router.delete('/api/boards/:id/xr-layout', 'location', (ctx) => {
      const u = person(ctx, true);
      const { board } = loadLivingBoard(app, ctx, ctx.params.id);
      drop(u.id, 'board', board.id);
      return { ok: true };
    });

    // --- Canvas ----------------------------------------------------------------------------------------------------
    router.get('/api/canvas/:id/xr-layout', 'location', (ctx) => {
      const u = person(ctx);
      const { board } = loadCanvasBoard(app, ctx, ctx.params.id);
      const r = read(u.id, 'canvas', board.id);
      return { layout: r ? tolerant(() => cleanCanvasLayout(r.layout)) : null, updated_at: r?.updated_at ?? null };
    });
    router.put('/api/canvas/:id/xr-layout', 'location', (ctx) => {
      const u = person(ctx, true);
      const { board } = loadCanvasBoard(app, ctx, ctx.params.id);
      const layout = checked(() => cleanCanvasLayout(ctx.body?.layout));
      return { layout, updated_at: write(u.id, 'canvas', board.id, board.location_id, layout) };
    });
    router.delete('/api/canvas/:id/xr-layout', 'location', (ctx) => {
      const u = person(ctx, true);
      const { board } = loadCanvasBoard(app, ctx, ctx.params.id);
      drop(u.id, 'canvas', board.id);
      return { ok: true };
    });

    // --- Arbeitsfläche ---------------------------------------------------------------------------------------------
    // Pages side by side. Only page names and widths are stored (no ids of records); every page checks its own rights.
    router.get('/api/xr/workspace', 'user', (ctx) => {
      const u = person(ctx);
      const r = read(u.id, 'workspace', '');
      return { layout: r ? tolerant(() => cleanWorkspace(r.layout)) : null, default: defaultWorkspace(), updated_at: r?.updated_at ?? null };
    });
    router.put('/api/xr/workspace', 'user', (ctx) => {
      const u = person(ctx, true);
      const layout = checked(() => cleanWorkspace(ctx.body?.layout));
      return { layout, updated_at: write(u.id, 'workspace', '', null, layout) };
    });
    router.delete('/api/xr/workspace', 'user', (ctx) => {
      const u = person(ctx, true);
      drop(u.id, 'workspace', '');
      return { ok: true };
    });

    // Layouts of deleted boards and canvases go away (at most every few hours; the foreign key already covers sub-accounts).
    let swept = 0;
    app.onTick(() => {
      if (Date.now() - swept < 6 * 3600_000) return;
      swept = Date.now();
      db.run(`DELETE FROM xr_layouts WHERE kind = 'board' AND subject_id NOT IN (SELECT id FROM boards)`);
      db.run(`DELETE FROM xr_layouts WHERE kind = 'canvas' AND subject_id NOT IN (SELECT id FROM canvas_boards)`);
    });
  },
};
