import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx, type RawResult } from '../core/http.js';
import { contentMatches, extFor } from '../core/files.js';
import { openIfSealed, sealSecret } from '../core/secrets.js';
import { id, now, sha256, token } from '../core/util.js';
import { CARD_KINDS, type CanvasElement, SceneError, cleanText, isId, sceneOutline } from '../services/canvas-model.js';
import { type CardData, type Prim, renderSvg, sceneDisplayList } from '../services/canvas-render.js';
import { CanvasHub, colorFor } from '../services/canvas-hub.js';
import { resolveCards } from '../services/canvas-cards.js';
import { buildTemplate, TEMPLATES } from '../services/canvas-templates.js';
import { mermaidToElements, MermaidError } from '../services/canvas-mermaid.js';
import { buildPdf, type PdfImage } from '../services/canvas-pdf.js';
import { type Bitmap, MAX_PIXELS, decodeImage, decodePng, encodePng, jpegSize, rasterize } from '../services/canvas-png.js';
import { type Access, type BoardRow, type OpIn, accessOf, actorOf, applyOps, boardElements, createSnapshot, freeSpot, graphOps, liftZ, loadBoard, planAdd as planAddRaw, relayoutOps, restoreSnapshot } from '../services/canvas-store.js';
import type { LayoutKind } from '../services/canvas-layout.js';
import { hiddenUser } from '../core/permissions.js';
import { userById } from '../services/collab-actor.js';
import { loginOf, sweepOnLoginChange } from '../services/stream-login.js';

/** New elements from a request: an element the scene cannot use (unknown type, a card without data …) is the caller's mistake – 400, not 500. */
const planAdd: typeof planAddRaw = (...args) => {
  try {
    return planAddRaw(...args);
  } catch (e) {
    if (e instanceof SceneError) throw bad(e.message);
    throw e;
  }
};

/**
 * Canvas: infinite whiteboard / design boards per sub-account – boards, element operations with
 * versions (last writer wins per element), realtime (SSE + presence), comments with @mentions,
 * snapshots, sharing (team, members, public read-only link) and exports (SVG/PNG/PDF → media library).
 * CRM integrations live in canvas-integrations.ts, MCP tools in canvas-mcp.ts, public link + mobile API
 * in canvas-public.ts. Contract: docs/canvas.md.
 */

const LAYOUTS: LayoutKind[] = ['flow', 'tree', 'mindmap', 'radial', 'grid'];
const DIRECTIONS = ['right', 'down', 'left', 'up'] as const;
const CLIENT_RE = /^[A-Za-z0-9_-]{6,64}$/;

export interface ExportOptions {
  format: 'svg' | 'png' | 'pdf';
  frameId?: string;
  ids?: string[];
  scale?: number;
  theme?: 'light' | 'dark';
  background?: string | null;
  /** PDF of a whole board with frames: one page per frame. */
  pages?: 'single' | 'frames';
}

export function boardOut(b: BoardRow, access?: Access | null) {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(b.settings || '{}');
  } catch {
    settings = {};
  }
  return {
    id: b.id,
    name: b.name,
    description: b.description,
    team_access: b.team_access,
    owner_id: b.owner_id,
    owner_name: b.owner_name,
    settings,
    seq: b.seq,
    element_count: b.element_count,
    created_at: b.created_at,
    updated_at: b.updated_at,
    updated_by: b.updated_by,
    ...(access ? { access } : {}),
  };
}

function cleanSettings(v: any, cur: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cur };
  if (!v || typeof v !== 'object') return out;
  if (v.grid !== undefined) out.grid = ['dots', 'lines', 'none'].includes(v.grid) ? v.grid : 'dots';
  if (v.snap !== undefined) out.snap = !!v.snap;
  if (v.sketch !== undefined) out.sketch = !!v.sketch;
  if (v.background !== undefined) out.background = typeof v.background === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.background) ? v.background : null;
  return out;
}

/** Image size from the first bytes (PNG, JPEG, GIF, WebP). */
export function imageSize(b: Buffer): { w: number; h: number } | null {
  if (b[0] === 0x89 && b.length > 24) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    const s = jpegSize(b);
    return s ? { w: s.w, h: s.h } : null;
  }
  if (b.toString('latin1', 0, 4) === 'GIF8') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

export const canvasModule: Module = {
  name: 'canvas',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE canvas_boards (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', team_access TEXT NOT NULL DEFAULT 'edit',
        owner_id TEXT, owner_name TEXT NOT NULL DEFAULT '', settings TEXT NOT NULL DEFAULT '{}',
        seq INTEGER NOT NULL DEFAULT 0, element_count INTEGER NOT NULL DEFAULT 0, last_snapshot_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX canvas_boards_loc ON canvas_boards(location_id, updated_at);
      CREATE TABLE canvas_elements (
        board_id TEXT NOT NULL REFERENCES canvas_boards(id) ON DELETE CASCADE, id TEXT NOT NULL,
        data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, seq INTEGER NOT NULL DEFAULT 0, z REAL NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (board_id, id)
      );
      CREATE INDEX canvas_elements_seq ON canvas_elements(board_id, seq);
      CREATE TABLE canvas_members (
        board_id TEXT NOT NULL REFERENCES canvas_boards(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'edit', created_at TEXT NOT NULL, PRIMARY KEY (board_id, user_id)
      );
      CREATE TABLE canvas_snapshots (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES canvas_boards(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, name TEXT NOT NULL DEFAULT '',
        elements TEXT NOT NULL, element_count INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0,
        auto INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE INDEX canvas_snapshots_board ON canvas_snapshots(board_id, created_at);
      CREATE TABLE canvas_comments (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES canvas_boards(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, element_id TEXT, x REAL, y REAL,
        parent_id TEXT, body TEXT NOT NULL, mentions TEXT NOT NULL DEFAULT '[]', author_id TEXT, author_name TEXT NOT NULL DEFAULT '',
        via TEXT NOT NULL DEFAULT '', resolved_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX canvas_comments_board ON canvas_comments(board_id, created_at);
      CREATE TABLE canvas_shares (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES canvas_boards(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE,
        token_sealed TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, revoked_at TEXT, last_used_at TEXT, views INTEGER NOT NULL DEFAULT 0
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const hub = new CanvasHub();
    app.services.canvasHub = hub;
    const uploadDir = join(app.config.dataDir, 'uploads');

    // A person's stream lasts as long as their login and their access: signed out or revoked → it ends at once (an expired
    // session, a lost right, the sub-account or the board taken away: at the next check, every 20 s).
    hub.revalidate = (boardId, s) => {
      if (!s.userId) return true;
      const u = userById(app, s.userId);
      const b = db.get<BoardRow>('SELECT * FROM canvas_boards WHERE id = ?', boardId);
      if (!u || !b) return false;
      if (u.role !== 'admin' && (!u.locations.includes(b.location_id) || (u.permissions && !u.permissions.includes('canvas')))) return false;
      return !!accessOf(app, { user: u, viaApiKey: false } as Ctx, b);
    };
    sweepOnLoginChange(app, hub);

    // --- helpers ------------------------------------------------------------------------------------
    const ops = (ctx: Ctx, board: BoardRow, list: OpIn[], o: { clientId?: string; strict?: boolean; force?: boolean } = {}) => {
      const r = applyOps(app, ctx, board, list, o);
      auditEdit(ctx, board);
      return r;
    };
    // People editing in the browser send many small batches: one audit line per person, board and 10 minutes.
    const lastAudit = new Map<string, number>();
    const auditEdit = (ctx: Ctx, board: BoardRow) => {
      if (ctx.via !== 'session') return;
      ctx.skipAfterWrite = true;
      const key = `${ctx.user?.id}:${board.id}`;
      if (Date.now() - (lastAudit.get(key) ?? 0) < 10 * 60_000) return;
      lastAudit.set(key, Date.now());
      if (lastAudit.size > 5000) lastAudit.clear();
      app.services.audit?.({ ctx, action: 'canvas.edit', route: `${ctx.method} /api/canvas/:id/ops`, entityId: board.id, summary: `Board „${board.name}“ bearbeitet` });
    };
    const cardRefs = (els: CanvasElement[]) => els.filter((e) => e.type === 'card' && e.card).map((e) => e.card!);

    /** Saves bytes into the media library (same table and folder as /api/uploads). */
    const saveMedia = (locationId: string, name: string, buf: Buffer, mime: string) => {
      mkdirSync(uploadDir, { recursive: true });
      const ext = mime === 'image/svg+xml' ? '.svg' : extFor(mime);
      const file = `${id(20)}${ext}`;
      writeFileSync(join(uploadDir, file), buf);
      const row = { id: id(), location_id: locationId, name: name.slice(0, 200), file, mime, size: buf.length, created_at: now() };
      db.insert('uploads', row);
      return { id: row.id, name: row.name, mime, size: buf.length, src: `/uploads/${file}`, url: `${app.baseUrl()}/uploads/${file}` };
    };
    app.services.canvasSaveMedia = saveMedia;

    const fileOf = (src: string) => {
      const m = src.match(/^\/uploads\/([A-Za-z0-9]{8,40}\.(png|jpg|jpeg|gif|webp))$/);
      if (!m) return null;
      const p = join(uploadDir, m[1]);
      return existsSync(p) ? p : null;
    };
    // decoded images for PNG exports (small cache, they are reused across exports of one board)
    const bitmaps = new Map<string, Bitmap | null>();
    const bitmapOf = (src: string): Bitmap | null => {
      if (bitmaps.has(src)) return bitmaps.get(src)!;
      const p = fileOf(src);
      const bmp = p ? decodeImage(readFileSync(p)) : null;
      if (bitmaps.size > 40) bitmaps.clear();
      bitmaps.set(src, bmp);
      return bmp;
    };

    /** Renders a board (or a frame / some elements) as SVG, PNG or PDF with the caller's live card data. */
    const exportBoard = async (ctx: Ctx | null, board: BoardRow, o: ExportOptions): Promise<{ bytes: Buffer; mime: string; ext: string; width: number; height: number }> => {
      const els = boardElements(app, board.id);
      if (o.frameId && !els.some((e) => e.id === o.frameId && e.type === 'frame')) throw notFound('Rahmen nicht gefunden');
      const cards: Record<string, CardData> = ctx ? await resolveCards(app, ctx, cardRefs(els)) : {};
      const background = o.background === null ? undefined : (o.background ?? '#ffffff');
      const scale = Math.min(4, Math.max(0.25, Number(o.scale) || (o.format === 'png' ? 2 : 1)));
      const base = { cards, publicView: !ctx, frameId: o.frameId, ids: o.ids?.length ? o.ids : undefined, theme: o.theme, background };
      if (o.format === 'svg') {
        const r = renderSvg(els, { ...base, imageHref: (src) => `${app.baseUrl()}${src}`, title: board.name });
        return { bytes: Buffer.from(r.svg, 'utf8'), mime: 'image/svg+xml', ext: 'svg', width: r.width, height: r.height };
      }
      if (o.format === 'png') {
        const dl = sceneDisplayList(els, { ...base, imageHref: (src) => src });
        let k = scale;
        if (dl.width * dl.height * k * k > MAX_PIXELS) k = Math.sqrt(MAX_PIXELS / (dl.width * dl.height));
        const images = new Map<string, Bitmap | null>();
        const collect = (ps: Prim[]) => ps.forEach((p) => (p.t === 'image' ? images.set(p.src, bitmapOf(p.src)) : p.t === 'group' ? collect(p.children) : null));
        collect(dl.prims);
        const prims: Prim[] = [{ t: 'group', m: [k, 0, 0, k, 0, 0], children: dl.prims }];
        const bmp = rasterize(prims, dl.width * k, dl.height * k, { images });
        return { bytes: encodePng(bmp), mime: 'image/png', ext: 'png', width: bmp.w, height: bmp.h };
      }
      // PDF: one page, or one page per frame
      const frames = els.filter((e) => e.type === 'frame' && !e.hidden);
      const pageOpts = o.pages === 'frames' && frames.length && !o.frameId && !o.ids?.length ? frames.map((f) => ({ ...base, frameId: f.id })) : [base];
      const pages = pageOpts.map((po) => {
        const dl = sceneDisplayList(els, { ...po, imageHref: (src) => src });
        return { width: dl.width, height: dl.height, prims: dl.prims };
      });
      const images = new Map<string, PdfImage>();
      const collect = (ps: Prim[]) =>
        ps.forEach((p) => {
          if (p.t === 'group') return collect(p.children);
          if (p.t !== 'image' || images.has(p.src)) return;
          const file = fileOf(p.src);
          if (!file) return;
          const buf = readFileSync(file);
          const size = jpegSize(buf);
          if (size) return void images.set(p.src, { kind: 'jpeg', data: buf, w: size.w, h: size.h, gray: size.gray });
          const bmp = buf[0] === 0x89 ? decodePng(buf) : null;
          if (!bmp) return;
          const rgb = Buffer.alloc(bmp.w * bmp.h * 3);
          const alpha = Buffer.alloc(bmp.w * bmp.h);
          let hasAlpha = false;
          for (let i = 0, j = 0; i < bmp.data.length; i += 4, j++) {
            rgb[j * 3] = bmp.data[i];
            rgb[j * 3 + 1] = bmp.data[i + 1];
            rgb[j * 3 + 2] = bmp.data[i + 2];
            alpha[j] = bmp.data[i + 3];
            if (bmp.data[i + 3] < 255) hasAlpha = true;
          }
          images.set(p.src, { kind: 'flate', rgb: deflateSync(rgb), alpha: hasAlpha ? deflateSync(alpha) : undefined, w: bmp.w, h: bmp.h });
        });
      for (const pg of pages) collect(pg.prims);
      const pdf = buildPdf(pages, { images, title: board.name });
      return { bytes: Buffer.from(pdf), mime: 'application/pdf', ext: 'pdf', width: pages[0]?.width ?? 0, height: pages[0]?.height ?? 0 };
    };
    app.services.canvasExport = exportBoard;

    const exportOptions = (v: Record<string, any>): ExportOptions => {
      const format = String(v.format ?? 'png').toLowerCase();
      if (!['svg', 'png', 'pdf'].includes(format)) throw bad('Format: png, svg oder pdf');
      const ids = Array.isArray(v.ids) ? v.ids.filter(isId) : typeof v.ids === 'string' && v.ids ? v.ids.split(',').filter(isId) : undefined;
      return {
        format: format as ExportOptions['format'],
        frameId: isId(v.frame_id) ? v.frame_id : undefined,
        ids,
        scale: v.scale !== undefined ? Number(v.scale) : undefined,
        theme: v.theme === 'dark' ? 'dark' : 'light',
        background: v.background === false || v.background === 'none' || v.transparent === true || v.transparent === '1' ? null : typeof v.background === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.background) ? v.background : undefined,
        pages: v.pages === 'frames' ? 'frames' : 'single',
      };
    };

    const people = (locationId: string) =>
      db
        .all<{ id: string; name: string; email: string; role: string; locations: string; permissions: string | null }>('SELECT id, name, email, role, locations, permissions FROM users ORDER BY name')
        .filter((u) => u.role === 'admin' || JSON.parse(u.locations || '[]').includes(locationId))
        .filter((u) => !hiddenUser(app, u, locationId))
        .filter((u) => u.role === 'admin' || !u.permissions || JSON.parse(u.permissions).includes('canvas'));

    const createBoard = (ctx: Ctx, input: { name: string; description?: string; team_access?: string; settings?: unknown }) => {
      const actor = actorOf(app, ctx);
      const b: BoardRow = {
        id: id(),
        location_id: ctx.locationId,
        name: input.name,
        description: cleanText(input.description ?? '', 2000),
        team_access: input.team_access === 'view' || input.team_access === 'none' ? input.team_access : 'edit',
        owner_id: actor.kind === 'user' ? actor.id : (ctx.user?.id ?? null),
        owner_name: actor.name.slice(0, 200),
        settings: JSON.stringify(cleanSettings(input.settings, { grid: 'dots', snap: true })),
        seq: 0,
        element_count: 0,
        last_snapshot_at: null,
        created_at: now(),
        updated_at: now(),
        updated_by: actor.name.slice(0, 200),
      };
      db.insert('canvas_boards', b);
      return b;
    };
    const fresh = (boardId: string) => db.get<BoardRow>('SELECT * FROM canvas_boards WHERE id = ?', boardId)!;

    // --- boards ------------------------------------------------------------------------------------
    router.get('/api/canvas', 'location', (ctx) => {
      const rows = db.all<BoardRow>('SELECT * FROM canvas_boards WHERE location_id = ? ORDER BY updated_at DESC LIMIT 500', ctx.locationId);
      const boards = rows.map((b) => ({ b, a: accessOf(app, ctx, b) })).filter((x) => x.a).map((x) => ({ ...boardOut(x.b, x.a), watching: hub.viewers(x.b.id).length }));
      const mentions = ctx.user
        ? Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM canvas_comments c WHERE c.location_id = ? AND c.resolved_at IS NULL AND EXISTS (SELECT 1 FROM json_each(c.mentions) WHERE value = ?)`, ctx.locationId, ctx.user.id)?.n ?? 0)
        : 0;
      return { boards, mentions };
    });

    router.get('/api/canvas/templates', 'location', () => TEMPLATES);

    router.post('/api/canvas', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const name = str(b.name, 'Name', { max: 200 }) || 'Neues Board';
      const board = createBoard(ctx, { name, description: b.description, team_access: b.team_access, settings: b.settings });
      let list: OpIn[] = [];
      try {
        if (b.template) {
          const els = buildTemplate(String(b.template), () => id(12), { x: 0, y: 0 });
          if (!els) throw bad('Unbekannte Vorlage');
          list = els.map((e) => ({ op: 'add', element: e }));
        } else if (b.mermaid) {
          list = mermaidToElements(str(b.mermaid, 'Mermaid', { max: 50_000 }), () => id(12), { x: 0, y: 0 }).elements.map((e) => ({ op: 'add', element: e }));
        } else if (Array.isArray(b.elements) && b.elements.length) {
          list = planAdd([], { elements: b.elements, origin: { x: 0, y: 0 } }, () => id(12)).ops;
        }
      } catch (e) {
        db.run('DELETE FROM canvas_boards WHERE id = ?', board.id);
        if (e instanceof MermaidError) throw bad(e.message);
        throw e;
      }
      if (list.length) applyOps(app, ctx, board, list);
      const out = fresh(board.id);
      return { ...boardOut(out, accessOf(app, ctx, out)), url: `/app/canvas/${out.id}` };
    });

    router.get('/api/canvas/mentions', 'location', (ctx) => {
      if (!ctx.user) return [];
      return db
        .all(
          `SELECT c.id, c.board_id, b.name AS board_name, c.element_id, c.body, c.author_name, c.created_at FROM canvas_comments c JOIN canvas_boards b ON b.id = c.board_id
           WHERE c.location_id = ? AND c.resolved_at IS NULL AND EXISTS (SELECT 1 FROM json_each(c.mentions) WHERE value = ?) ORDER BY c.created_at DESC LIMIT 100`,
          ctx.locationId,
          ctx.user.id,
        )
        .filter((c: any) => {
          const b = db.get<BoardRow>('SELECT * FROM canvas_boards WHERE id = ?', c.board_id);
          return !!b && !!accessOf(app, ctx, b);
        });
    });

    router.get('/api/canvas/media', 'location', (ctx) =>
      db
        .all(`SELECT id, name, file, mime, size, created_at FROM uploads WHERE location_id = ? AND mime IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp') ORDER BY created_at DESC LIMIT 200`, ctx.locationId)
        .map((u: any) => ({ id: u.id, name: u.name, mime: u.mime, size: u.size, created_at: u.created_at, src: `/uploads/${u.file}`, url: `${app.baseUrl()}/uploads/${u.file}` })),
    );

    router.get('/api/canvas/:id', 'location', async (ctx) => {
      const { board, access } = loadBoard(app, ctx, ctx.params.id);
      const elements = boardElements(app, board.id);
      const out: Record<string, unknown> = { board: boardOut(board, access), access, seq: board.seq, elements, viewers: hub.viewers(board.id), me: ctx.user ? { id: ctx.user.id, name: ctx.user.name, color: colorFor(ctx.user.id) } : null };
      if (ctx.query.get('outline')) out.outline = sceneOutline(elements, board.name);
      if (ctx.query.get('svg')) out.svg = renderSvg(elements, { cards: await resolveCards(app, ctx, cardRefs(elements)), imageHref: (src) => `${app.baseUrl()}${src}`, background: '#ffffff', maxSize: Number(ctx.query.get('max')) || undefined }).svg;
      return out;
    });

    router.patch('/api/canvas/:id', 'location', (ctx) => {
      const { board, access } = loadBoard(app, ctx, ctx.params.id, 'edit');
      const b = ctx.body ?? {};
      const patch: Record<string, unknown> = { updated_at: now() };
      if (b.name !== undefined) patch.name = str(b.name, 'Name', { required: true, max: 200 });
      if (b.description !== undefined) patch.description = cleanText(b.description, 2000);
      if (b.settings !== undefined) patch.settings = JSON.stringify(cleanSettings(b.settings, JSON.parse(board.settings || '{}')));
      if (b.team_access !== undefined) {
        if (access !== 'owner') throw new HttpError(403, 'Nur die Besitzerin/der Besitzer des Boards darf die Freigabe ändern');
        if (!['edit', 'view', 'none'].includes(b.team_access)) throw bad('team_access: edit, view oder none');
        patch.team_access = b.team_access;
      }
      db.update('canvas_boards', board.id, patch, ctx.locationId);
      const out = fresh(board.id);
      hub.publish(board.id, 'board', boardOut(out));
      return boardOut(out, accessOf(app, ctx, out));
    });

    router.delete('/api/canvas/:id', 'location', (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id, 'owner');
      db.run('DELETE FROM canvas_boards WHERE id = ? AND location_id = ?', board.id, ctx.locationId);
      hub.publish(board.id, 'deleted', { id: board.id });
      hub.closeBoard(board.id);
      return { ok: true, id: board.id, name: board.name };
    });

    router.post('/api/canvas/:id/duplicate', 'location', (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id);
      const copy = createBoard(ctx, { name: str(ctx.body?.name, 'Name', { max: 200 }) || `${board.name} (Kopie)`, description: board.description, team_access: board.team_access, settings: JSON.parse(board.settings || '{}') });
      const els = boardElements(app, board.id);
      if (els.length) applyOps(app, ctx, copy, els.map((e) => ({ op: 'add', element: e })));
      const out = fresh(copy.id);
      return { ...boardOut(out, accessOf(app, ctx, out)), url: `/app/canvas/${out.id}` };
    });

    // --- elements --------------------------------------------------------------------------------------
    router.post('/api/canvas/:id/ops', 'location', (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id, 'edit');
      const b = ctx.body ?? {};
      const clientId = CLIENT_RE.test(String(b.clientId ?? '')) ? String(b.clientId) : undefined;
      const r = ops(ctx, board, b.ops, { clientId, strict: !!b.strict });
      // elements the caller is out of date with (conflicts, refusals) come back in their current state
      const stale = new Set(r.results.filter((x) => x.status !== 'ok').map((x) => x.id));
      const current = stale.size ? boardElements(app, board.id).filter((e) => stale.has(e.id)) : [];
      return { id: board.id, name: board.name, seq: r.seq, results: r.results, current, ...(b.echo ? { elements: r.elements, deleted: r.deleted } : {}) };
    });

    router.post('/api/canvas/:id/elements', 'location', (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id, 'edit');
      const b = ctx.body ?? {};
      const existing = boardElements(app, board.id);
      const layout = b.layout && LAYOUTS.includes(b.layout.kind ?? b.layout) ? { kind: (b.layout.kind ?? b.layout) as LayoutKind, direction: DIRECTIONS.includes(b.layout.direction) ? b.layout.direction : undefined, gap: Number(b.layout.gap) || undefined } : undefined;
      const origin = b.origin && Number.isFinite(Number(b.origin.x)) && Number.isFinite(Number(b.origin.y)) ? { x: Number(b.origin.x), y: Number(b.origin.y) } : undefined;
      const plan = planAdd(existing, { elements: b.elements, layout, origin }, () => id(12));
      const r = ops(ctx, board, plan.ops);
      const failed = r.results.filter((x) => x.status === 'error');
      if (failed.length && failed.length === r.results.length) throw bad(failed[0].error ?? 'Elemente ungültig');
      return { id: board.id, name: board.name, seq: r.seq, refs: plan.refs, created: r.results.filter((x) => x.status === 'ok').map((x) => x.id), errors: failed, elements: r.elements };
    });

    router.get('/api/canvas/:id/changes', 'location', (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id);
      const since = Math.max(0, Math.floor(Number(ctx.query.get('since')) || 0));
      const rows = db.all<{ id: string; data: string; version: number; z: number; deleted: number }>('SELECT id, data, version, z, deleted FROM canvas_elements WHERE board_id = ? AND seq > ? ORDER BY seq', board.id, since);
      return {
        seq: board.seq,
        elements: rows.filter((r) => !r.deleted).map((r) => ({ ...JSON.parse(r.data), version: r.version, z: r.z })),
        deleted: rows.filter((r) => r.deleted).map((r) => r.id),
      };
    });

    router.get('/api/canvas/:id/stream', 'location', (ctx): RawResult => {
      const { board } = loadBoard(app, ctx, ctx.params.id);
      const clientId = String(ctx.query.get('clientId') ?? '');
      if (!CLIENT_RE.test(clientId)) throw bad('clientId fehlt');
      const actor = actorOf(app, ctx);
      // the stream ends with the login it was opened with: a person's (browser, app; their access is re-checked too) or a key's
      // (deleted key, disconnected MCP connection)
      const alive = loginOf(app, ctx);
      const own = (ctx.via === 'session' || ctx.via === 'app') && ctx.user;
      const person = alive ? { userId: own ? ctx.user!.id : undefined, alive } : undefined;
      const stream = hub.subscribe(board.id, { clientId, userId: actor.id ?? undefined, name: actor.name, color: colorFor(actor.id ?? actor.name), kind: actor.kind, at: Date.now() }, board.seq, person);
      // not a 200 stream that ends at once: the browser's EventSource gives up instead of retrying every few seconds
      if (!stream) throw new HttpError(503, 'Zu viele Live-Verbindungen – bitte später noch einmal');
      return { __raw: true, status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' }, body: stream };
    });

    router.post('/api/canvas/:id/presence', 'location', (ctx) => {
      ctx.skipAfterWrite = true;
      const { board } = loadBoard(app, ctx, ctx.params.id);
      const b = ctx.body ?? {};
      const clientId = String(b.clientId ?? '');
      if (!CLIENT_RE.test(clientId)) throw bad('clientId fehlt');
      const actor = actorOf(app, ctx);
      const num = (v: unknown) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : undefined);
      hub.touch(board.id, { clientId, userId: actor.id ?? undefined, name: actor.name, color: colorFor(actor.id ?? actor.name), kind: actor.kind, x: num(b.x), y: num(b.y), sel: Array.isArray(b.sel) ? b.sel.filter(isId).slice(0, 100) : undefined, at: Date.now() });
      return { ok: true };
    });

    // --- rendering & export -------------------------------------------------------------------------------
    router.get('/api/canvas/:id/svg', 'location', async (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id);
      const els = boardElements(app, board.id);
      const thumb = !!ctx.query.get('thumb');
      const r = renderSvg(els, {
        cards: thumb ? {} : await resolveCards(app, ctx, cardRefs(els)),
        publicView: thumb,
        imageHref: (src) => (thumb ? src : `${app.baseUrl()}${src}`),
        background: ctx.query.get('transparent') ? undefined : '#ffffff',
        theme: ctx.query.get('theme') === 'dark' ? 'dark' : 'light',
        frameId: isId(ctx.query.get('frame')) ? ctx.query.get('frame')! : undefined,
        maxSize: thumb ? 640 : undefined,
        idPrefix: `b${board.id.slice(0, 8)}`,
        title: board.name,
      });
      return { __raw: true, status: 200, headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; img-src 'self' data: https:; style-src 'unsafe-inline'" }, body: r.svg };
    });

    router.get('/api/canvas/:id/export', 'location', async (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id);
      const o = exportOptions(Object.fromEntries(ctx.query));
      const r = await exportBoard(ctx, board, o);
      const fname = `${board.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60) || 'canvas'}.${r.ext}`;
      return { __raw: true, status: 200, headers: { 'content-type': r.mime, 'content-disposition': `attachment; filename="${encodeURIComponent(fname)}"`, 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; img-src 'self' data: https:; style-src 'unsafe-inline'" }, body: r.bytes };
    });

    router.post('/api/canvas/:id/export', 'location', async (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id);
      const o = exportOptions(ctx.body ?? {});
      const r = await exportBoard(ctx, board, o);
      const name = str(ctx.body?.name, 'Name', { max: 150 }) || `${board.name} – Canvas`;
      const media = saveMedia(ctx.locationId, `${name}.${r.ext}`, r.bytes, r.mime);
      return { ...media, format: o.format, width: r.width, height: r.height, board_id: board.id };
    });

    // Images for the board (upload, paste, drag & drop): same checks as the media library.
    router.post('/api/canvas/:id/media', 'location', (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id, 'edit');
      const name = str(ctx.body?.name, 'Dateiname', { max: 200 }) || 'Bild';
      const m = String(ctx.body?.data ?? '').match(/^data:([\w/+.-]+);base64,(.+)$/);
      if (!m) throw bad('Erwarte eine data:-URL');
      const mime = m[1];
      if (!/^image\/(png|jpeg|gif|webp)$/.test(mime)) throw bad('Nur PNG, JPG, GIF oder WebP');
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 8 * 1024 * 1024) throw bad('Datei größer als 8 MB');
      if (!contentMatches(mime, buf)) throw bad('Dateiinhalt passt nicht zum Dateityp');
      const media = saveMedia(ctx.locationId, name, buf, mime);
      return { ...media, ...(imageSize(buf) ?? {}), board_id: board.id };
    });

    // --- generators: templates, Mermaid, layout ---------------------------------------------------------------
    const at = (b: any) => (b && Number.isFinite(Number(b.x)) && Number.isFinite(Number(b.y)) ? { x: Number(b.x), y: Number(b.y) } : undefined);

    router.post('/api/canvas/:id/template', 'location', (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id, 'edit');
      const existing = boardElements(app, board.id);
      const els = buildTemplate(String(ctx.body?.key ?? ''), () => id(12), at(ctx.body) ?? freeSpot(existing));
      if (!els) throw bad('Unbekannte Vorlage');
      const r = ops(ctx, board, liftZ(existing, els).map((e) => ({ op: 'add', element: e })), { clientId: ctx.body?.clientId });
      return { id: board.id, name: board.name, seq: r.seq, created: r.elements.map((e) => e.id) };
    });

    router.post('/api/canvas/:id/mermaid', 'location', (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id, 'edit');
      const existing = boardElements(app, board.id);
      let res;
      try {
        res = mermaidToElements(str(ctx.body?.source ?? ctx.body?.mermaid, 'Mermaid', { required: true, max: 50_000 }), () => id(12), at(ctx.body) ?? freeSpot(existing), { sketch: !!ctx.body?.sketch });
      } catch (e) {
        if (e instanceof MermaidError) throw bad(e.message);
        throw e;
      }
      const r = ops(ctx, board, liftZ(existing, res.elements).map((e) => ({ op: 'add', element: e })), { clientId: ctx.body?.clientId });
      return { id: board.id, name: board.name, seq: r.seq, kind: res.kind, created: r.elements.map((e) => e.id) };
    });

    router.post('/api/canvas/:id/layout', 'location', (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id, 'edit');
      const b = ctx.body ?? {};
      const kind = (LAYOUTS.includes(b.kind) ? b.kind : 'flow') as LayoutKind;
      const direction = DIRECTIONS.includes(b.direction) ? b.direction : undefined;
      const existing = boardElements(app, board.id);
      let list: OpIn[];
      let ids: Record<string, string> | undefined;
      if (Array.isArray(b.nodes) && b.nodes.length) {
        // new graph from nodes/edges
        const nodes = b.nodes.slice(0, 300).map((n: any, i: number) => ({ id: String(n?.id ?? `n${i}`).slice(0, 60), label: cleanText(n?.label ?? n?.text ?? n?.id ?? '', 300), shape: ['rect', 'round', 'ellipse', 'diamond', 'sticky', 'text', 'pill'].includes(n?.shape) ? n.shape : undefined, fill: n?.fill, stroke: n?.stroke, group: n?.group ? String(n.group) : undefined }));
        const edges = (Array.isArray(b.edges) ? b.edges : []).slice(0, 800).map((e: any) => ({ from: String(e?.from ?? ''), to: String(e?.to ?? ''), label: e?.label ? cleanText(e.label, 200) : undefined, dashed: !!e?.dashed }));
        const style = kind === 'mindmap' || kind === 'radial' ? 'mindmap' : 'flowchart';
        const g = graphOps(existing, { nodes, edges, layout: kind, direction, style, sketch: !!b.sketch, groups: Array.isArray(b.groups) ? b.groups.map((x: any) => ({ id: String(x.id), title: cleanText(x.title ?? x.id, 200) })) : undefined }, at(b));
        list = g.ops;
        ids = g.ids;
      } else list = relayoutOps(existing, Array.isArray(b.ids) ? b.ids.filter(isId) : undefined, { kind, direction, gap: Number(b.gap) || undefined });
      const r = ops(ctx, board, list, { clientId: b.clientId });
      return { id: board.id, name: board.name, seq: r.seq, kind, ...(ids ? { ids } : {}), changed: r.elements.length };
    });

    // --- live CRM cards ---------------------------------------------------------------------------------------
    router.post('/api/canvas/:id/cards', 'location', async (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id);
      const refs = Array.isArray(ctx.body?.refs) ? ctx.body.refs.filter((r: any) => r && (CARD_KINDS as readonly string[]).includes(r.kind) && (isId(r.id) || r.id === 'current')) : cardRefs(boardElements(app, board.id));
      return { cards: await resolveCards(app, ctx, refs) };
    });

    // --- people, members (sharing) ------------------------------------------------------------------------------
    router.get('/api/canvas/:id/people', 'location', (ctx) => {
      const { board, access } = loadBoard(app, ctx, ctx.params.id);
      const roles = new Map(db.all<{ user_id: string; role: string }>('SELECT user_id, role FROM canvas_members WHERE board_id = ?', board.id).map((m) => [m.user_id, m.role]));
      return people(ctx.locationId).map((u) => ({ id: u.id, name: u.name, ...(access === 'owner' ? { email: u.email } : {}), admin: u.role === 'admin', member: roles.get(u.id) ?? null, owner: u.id === board.owner_id }));
    });

    router.put('/api/canvas/:id/members', 'location', (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id, 'owner');
      const userId = String(ctx.body?.user_id ?? '');
      const role = String(ctx.body?.role ?? '');
      if (!['edit', 'view', 'none'].includes(role)) throw bad('role: edit, view oder none');
      if (!people(ctx.locationId).some((u) => u.id === userId)) throw bad('Diese Person hat keinen Zugang zu diesem Sub-Account oder zum Canvas');
      if (role === 'none') db.run('DELETE FROM canvas_members WHERE board_id = ? AND user_id = ?', board.id, userId);
      else db.run('INSERT INTO canvas_members (board_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(board_id, user_id) DO UPDATE SET role = excluded.role', board.id, userId, role, now());
      return { ok: true, id: board.id, name: board.name, user_id: userId, role };
    });

    // --- snapshots (version history) -----------------------------------------------------------------------------
    router.get('/api/canvas/:id/snapshots', 'location', (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id);
      return db.all('SELECT id, name, element_count, seq, auto, created_by, created_at FROM canvas_snapshots WHERE board_id = ? ORDER BY created_at DESC LIMIT 100', board.id);
    });
    router.post('/api/canvas/:id/snapshots', 'location', (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id, 'edit');
      const s = createSnapshot(app, board.id, str(ctx.body?.name, 'Name', { max: 200 }) || `Version vom ${new Date().toLocaleString('de-DE', { timeZone: app.location(ctx.locationId)?.timezone || 'Europe/Berlin' })}`, false, actorOf(app, ctx));
      return { ...s, name: board.name };
    });
    router.get('/api/canvas/:id/snapshots/:sid/svg', 'location', (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id);
      const s = db.get<{ elements: string }>('SELECT elements FROM canvas_snapshots WHERE id = ? AND board_id = ?', ctx.params.sid, board.id);
      if (!s) throw notFound('Version nicht gefunden');
      const r = renderSvg(JSON.parse(s.elements), { publicView: true, background: '#ffffff', maxSize: 800, idPrefix: `s${ctx.params.sid.slice(0, 6)}` });
      return { __raw: true, status: 200, headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'" }, body: r.svg };
    });
    router.post('/api/canvas/:id/snapshots/:sid/restore', 'location', (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id, 'edit');
      const r = restoreSnapshot(app, ctx, board, ctx.params.sid, ctx.body?.clientId);
      return { id: board.id, name: board.name, seq: r.seq, restored: r.elements.length };
    });
    router.delete('/api/canvas/:id/snapshots/:sid', 'location', (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id, 'owner');
      if (!db.run('DELETE FROM canvas_snapshots WHERE id = ? AND board_id = ?', ctx.params.sid, board.id).changes) throw notFound('Version nicht gefunden');
      return { ok: true };
    });

    // --- public read-only links ---------------------------------------------------------------------------------
    const shareOut = (s: any) => ({ id: s.id, label: s.label, created_by: s.created_by, created_at: s.created_at, revoked_at: s.revoked_at, last_used_at: s.last_used_at, views: s.views, url: s.revoked_at ? null : `${app.baseUrl()}/canvas/s/${openIfSealed(app, s.token_sealed)}` });
    router.get('/api/canvas/:id/shares', 'location', (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id, 'owner');
      return db.all('SELECT * FROM canvas_shares WHERE board_id = ? ORDER BY created_at DESC', board.id).map(shareOut);
    });
    router.post('/api/canvas/:id/shares', 'location', (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id, 'owner');
      if (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canvas_shares WHERE board_id = ? AND revoked_at IS NULL', board.id)!.n >= 10) throw bad('Höchstens 10 aktive Links je Board');
      const tok = token(24);
      const row = { id: id(), board_id: board.id, location_id: ctx.locationId, token_hash: sha256(tok), token_sealed: sealSecret(app, tok), label: str(ctx.body?.label, 'Bezeichnung', { max: 120 }), created_by: actorOf(app, ctx).name.slice(0, 200), created_at: now(), revoked_at: null, last_used_at: null, views: 0 };
      db.insert('canvas_shares', row);
      return { ...shareOut(row), name: board.name };
    });
    router.delete('/api/canvas/:id/shares/:sid', 'location', (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id, 'owner');
      if (!db.run('UPDATE canvas_shares SET revoked_at = ? WHERE id = ? AND board_id = ? AND revoked_at IS NULL', now(), ctx.params.sid, board.id).changes) throw notFound('Link nicht gefunden');
      return { ok: true, id: ctx.params.sid };
    });

    // --- comments with @mentions ------------------------------------------------------------------------------------
    const commentOut = (c: any) => ({ ...c, mentions: JSON.parse(c.mentions || '[]') });
    router.get('/api/canvas/:id/comments', 'location', (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id);
      return db.all('SELECT * FROM canvas_comments WHERE board_id = ? ORDER BY created_at LIMIT 2000', board.id).map(commentOut);
    });
    router.post('/api/canvas/:id/comments', 'location', async (ctx) => {
      const { board } = loadBoard(app, ctx, ctx.params.id);
      const b = ctx.body ?? {};
      const body = cleanText(str(b.body, 'Kommentar', { required: true, max: 5000 }), 5000);
      const actor = actorOf(app, ctx);
      let parent: any;
      if (b.parent_id) {
        parent = db.get('SELECT * FROM canvas_comments WHERE id = ? AND board_id = ?', String(b.parent_id), board.id);
        if (!parent) throw notFound('Kommentar nicht gefunden');
      }
      const elementId = isId(b.element_id) ? b.element_id : (parent?.element_id ?? null);
      if (elementId && !db.get('SELECT 1 AS x FROM canvas_elements WHERE board_id = ? AND id = ? AND deleted = 0', board.id, elementId)) throw bad('Element nicht gefunden');
      // mentions: ids from the editor's picker, or "@Name" in the text (API/agents)
      const team = people(ctx.locationId).filter((u) => accessOf(app, { ...ctx, user: { id: u.id, email: u.email, name: u.name, role: u.role as 'admin' | 'member', locations: JSON.parse(u.locations || '[]'), permissions: u.permissions ? JSON.parse(u.permissions) : null } }, board));
      const mentioned = new Set<string>();
      for (const uid of Array.isArray(b.mentions) ? b.mentions : []) if (team.some((u) => u.id === uid)) mentioned.add(String(uid));
      const lower = body.toLowerCase();
      for (const u of team) if (u.name && lower.includes(`@${u.name.toLowerCase()}`)) mentioned.add(u.id);
      const num = (v: unknown) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
      const row = { id: id(), board_id: board.id, location_id: ctx.locationId, element_id: elementId, x: num(b.x), y: num(b.y), parent_id: parent?.id ?? null, body, mentions: JSON.stringify([...mentioned]), author_id: actor.id, author_name: actor.name.slice(0, 200), via: String(ctx.via ?? ''), resolved_at: null, created_at: now(), updated_at: now() };
      db.insert('canvas_comments', row);
      hub.publish(board.id, 'comment', commentOut(row));
      const notify = [...mentioned].filter((u) => u !== actor.id);
      if (notify.length) {
        const link = `/app/canvas/${board.id}?comment=${row.id}`;
        const title = `${actor.name} hat dich auf „${board.name}“ erwähnt`;
        try {
          await app.services.pushNotify?.({ userIds: notify, kind: 'canvas', title, body, url: link, tag: `canvas:${row.id}` });
        } catch (e) {
          console.error('[canvas] push', (e as Error).message);
        }
        for (const u of notify) app.services.mobileFeed?.({ locationId: ctx.locationId, type: 'canvas_mention', area: '', userId: u, title, body, link, ref: `canvas:${row.id}:${u}` });
      }
      return { ...commentOut(row), name: board.name, notified: notify.length };
    });
    router.patch('/api/canvas/:id/comments/:cid', 'location', (ctx) => {
      const { board, access } = loadBoard(app, ctx, ctx.params.id);
      const c = db.get('SELECT * FROM canvas_comments WHERE id = ? AND board_id = ?', ctx.params.cid, board.id);
      if (!c) throw notFound('Kommentar nicht gefunden');
      const actor = actorOf(app, ctx);
      const mine = !!actor.id && c.author_id === actor.id;
      const patch: Record<string, unknown> = { updated_at: now() };
      if (ctx.body?.body !== undefined) {
        if (!mine) throw new HttpError(403, 'Nur eigene Kommentare bearbeiten');
        patch.body = cleanText(str(ctx.body.body, 'Kommentar', { required: true, max: 5000 }), 5000);
      }
      if (ctx.body?.resolved !== undefined) {
        if (!mine && access === 'view') throw new HttpError(403, 'Nur Lesezugriff auf dieses Board');
        patch.resolved_at = ctx.body.resolved ? now() : null;
      }
      db.update('canvas_comments', c.id, patch);
      const out = commentOut(db.get('SELECT * FROM canvas_comments WHERE id = ?', c.id));
      hub.publish(board.id, 'comment', out);
      return out;
    });
    router.delete('/api/canvas/:id/comments/:cid', 'location', (ctx) => {
      const { board, access } = loadBoard(app, ctx, ctx.params.id);
      const c = db.get('SELECT * FROM canvas_comments WHERE id = ? AND board_id = ?', ctx.params.cid, board.id);
      if (!c) throw notFound('Kommentar nicht gefunden');
      const actor = actorOf(app, ctx);
      if (!(actor.id && c.author_id === actor.id) && access !== 'owner') throw new HttpError(403, 'Nur eigene Kommentare löschen');
      db.run('DELETE FROM canvas_comments WHERE (id = ? OR parent_id = ?) AND board_id = ?', c.id, c.id, board.id);
      hub.publish(board.id, 'comment-deleted', { id: c.id });
      return { ok: true };
    });
  },
};
