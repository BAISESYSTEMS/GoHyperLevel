import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str, text, type Ctx } from '../core/http.js';
import { areaAllowed } from '../services/canvas-cards.js';
import { accessOf, type BoardRow } from '../services/canvas-store.js';
import { contentMatches, extFor } from '../core/files.js';
import { openIfSealed, sealSecret } from '../core/secrets.js';
import { id, now, sha256, slugify, token } from '../core/util.js';
import { actorOf, asUser, isBot, teamUsers } from '../services/collab-actor.js';
import { registerCardKind, resolveEmbeds, type EmbedCard } from '../services/collab-cards.js';
import { createFts } from '../services/collab-fts.js';
import { CARD_KINDS, extractRefs, firstHeading, htmlToMarkdown, lineDiff, markdownToText, portableMarkdown, renderMarkdown, renderChat, taskCount, toggleTask } from '../services/wiki-markdown.js';
import { WIKI_TEMPLATES, fillTemplate, templateByKey } from '../services/wiki-templates.js';
import {
  LIMITS,
  accessibleSpaces,
  cleanBody,
  cleanIcon,
  cleanTitle,
  createPage,
  loadPage,
  loadSpace,
  movePage,
  pagePath,
  purgeIds,
  reindexAll,
  restorePage,
  restoreVersion,
  searchPages,
  spaceAccess,
  subtreeIds,
  track,
  trashPage,
  updatePage,
  type PageRow,
  type SpaceAccess,
  type SpaceRow,
} from '../services/wiki-store.js';

/**
 * Wiki: team-internal knowledge per sub-account – spaces with a page tree (nested, drag & drop order),
 * Markdown pages with live record cards, @mentions and checklists, version history with restore,
 * comments, favourites, full-text search (FTS5), templates, share links, import/export.
 * Publishing to the help center, AI helpers and PDF export are in wiki-extras.ts, public share pages in
 * wiki-public.ts, MCP tools in wiki-mcp.ts. Contract: docs/wiki.md.
 */

const UPLOAD_TYPES = /^(image\/(png|jpeg|gif|webp)|application\/(pdf|zip)|text\/(plain|csv)|application\/vnd\.(openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|oasis\.opendocument\.(text|spreadsheet|presentation)))$/;
export const IMPORT_LIMITS = { files: 50, bytes: 1_000_000 };

export const wikiModule: Module = {
  name: 'wiki',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE wiki_spaces (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
        team_access TEXT NOT NULL DEFAULT 'edit', owner_id TEXT, owner_name TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX wiki_spaces_loc ON wiki_spaces(location_id, position);
      CREATE TABLE wiki_pages (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        space_id TEXT NOT NULL REFERENCES wiki_spaces(id) ON DELETE CASCADE, parent_id TEXT,
        position INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
        trashed_at TEXT, kb_article_id TEXT, kb_version INTEGER,
        created_by TEXT, created_by_name TEXT NOT NULL DEFAULT '', updated_by TEXT, updated_by_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX wiki_pages_tree ON wiki_pages(space_id, parent_id, position);
      CREATE INDEX wiki_pages_loc ON wiki_pages(location_id, updated_at);
      CREATE INDEX wiki_pages_title ON wiki_pages(location_id, title);
      CREATE INDEX wiki_pages_trash ON wiki_pages(trashed_at) WHERE trashed_at IS NOT NULL;
      CREATE TABLE wiki_versions (
        id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, rev INTEGER NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, author_id TEXT, author_name TEXT NOT NULL DEFAULT '',
        via TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, saved_at TEXT NOT NULL
      );
      CREATE INDEX wiki_versions_page ON wiki_versions(page_id, rev);
      CREATE TABLE wiki_comments (
        id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, parent_id TEXT,
        body TEXT NOT NULL, quote TEXT NOT NULL DEFAULT '', mentions TEXT NOT NULL DEFAULT '[]',
        author_id TEXT, author_name TEXT NOT NULL DEFAULT '', via TEXT NOT NULL DEFAULT '',
        resolved_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX wiki_comments_page ON wiki_comments(page_id, created_at);
      CREATE TABLE wiki_favorites (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY (user_id, page_id)
      );
      CREATE TABLE wiki_shares (
        id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE,
        token_sealed TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, revoked_at TEXT, last_used_at TEXT, views INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX wiki_shares_page ON wiki_shares(page_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.wikiFts = createFts(db, 'wiki_fts', ['title', 'body']);
    reindexAll(app);
    const uploadDir = join(app.config.dataDir, 'uploads');
    /** Edits arrive as autosaves: one audit line per person, page and ten minutes (versions keep every save). */
    const lastAudit = new Map<string, number>();
    const quiet = (ctx: Ctx) => {
      ctx.skipAfterWrite = true;
    };

    // --- helpers -------------------------------------------------------------------------------------
    const favorites = (ctx: Ctx): Set<string> => new Set(ctx.user && !ctx.viaApiKey ? db.all<{ page_id: string }>('SELECT page_id FROM wiki_favorites WHERE user_id = ? AND location_id = ?', ctx.user.id, ctx.locationId).map((r) => r.page_id) : []);
    const spaceOut = (s: SpaceRow, access: SpaceAccess) => ({
      id: s.id,
      name: s.name,
      icon: s.icon,
      description: s.description,
      team_access: s.team_access,
      owner_id: s.owner_id,
      owner_name: s.owner_name,
      position: s.position,
      updated_at: s.updated_at,
      access,
      page_count: Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM wiki_pages WHERE space_id = ? AND trashed_at IS NULL', s.id)?.n ?? 0),
    });
    const render = (p: PageRow, access: SpaceAccess) => renderMarkdown(p.body, { interactive: access !== 'view', baseLevel: 2 });
    const pageOut = (ctx: Ctx, p: PageRow, s: SpaceRow, access: SpaceAccess, full = true) => {
      const base = {
        id: p.id,
        space_id: p.space_id,
        space_name: s.name,
        parent_id: p.parent_id,
        position: p.position,
        title: p.title,
        icon: p.icon,
        version: p.version,
        created_by_name: p.created_by_name,
        updated_by_name: p.updated_by_name,
        created_at: p.created_at,
        updated_at: p.updated_at,
        trashed_at: p.trashed_at,
        access,
      };
      if (!full) return base;
      const r = render(p, access);
      const [done, total] = taskCount(p.body);
      const comments = db.get<{ total: number; open: number }>('SELECT COUNT(*) AS total, COALESCE(SUM(resolved_at IS NULL), 0) AS open FROM wiki_comments WHERE page_id = ?', p.id)!;
      const backlinks = db.all<{ id: string; title: string; icon: string; space_id: string }>(`SELECT id, title, icon, space_id FROM wiki_pages WHERE location_id = ? AND trashed_at IS NULL AND id != ? AND body LIKE ? LIMIT 30`, ctx.locationId, p.id, `%(page:${p.id})%`).filter((b) => {
        const sp = db.get<SpaceRow>('SELECT * FROM wiki_spaces WHERE id = ?', b.space_id);
        return !!sp && !!spaceAccess(ctx, sp);
      });
      return {
        ...base,
        body: p.body,
        html: r.html,
        toc: r.toc,
        tasks: { done, total },
        path: pagePath(app, p),
        children: db.all('SELECT id, title, icon FROM wiki_pages WHERE space_id = ? AND parent_id = ? AND trashed_at IS NULL ORDER BY position, title', p.space_id, p.id),
        backlinks: backlinks.map((b) => ({ id: b.id, title: b.title, icon: b.icon })),
        favorite: favorites(ctx).has(p.id),
        comments,
        shares: Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM wiki_shares WHERE page_id = ? AND revoked_at IS NULL', p.id)?.n ?? 0),
        published: p.kb_article_id ? { article_id: p.kb_article_id, version: p.kb_version, outdated: (p.kb_version ?? 0) < p.version } : null,
        words: p.text ? p.text.split(/\s+/).filter(Boolean).length : 0,
      };
    };
    app.services.wikiPageOut = pageOut;

    const nextSpacePosition = (loc: string) => Number(db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM wiki_spaces WHERE location_id = ?', loc)?.n ?? 0);
    const cleanName = (v: unknown) => {
      const n = str(v, 'Name', { required: true, max: 80 });
      return n;
    };
    const cleanAccess = (v: unknown, fallback: SpaceRow['team_access'] = 'edit') => {
      if (v === undefined) return fallback;
      if (!['edit', 'view', 'none'].includes(String(v))) throw bad('team_access: edit, view oder none');
      return v as SpaceRow['team_access'];
    };

    // --- card kind "wiki" (links to pages in chat and other pages) ----------------------------------------
    registerCardKind(app, 'wiki', (a, ctx, pid) => {
      const p = a.db.get<PageRow>('SELECT * FROM wiki_pages WHERE id = ? AND location_id = ? AND trashed_at IS NULL', pid, ctx.locationId);
      const s = p && a.db.get<SpaceRow>('SELECT * FROM wiki_spaces WHERE id = ?', p.space_id);
      if (!p || !s || !spaceAccess(ctx, s) || !areaAllowed(a, ctx, '/api/wiki')) return { ok: false, kind: 'wiki', error: 'Seite nicht gefunden (gelöscht oder kein Zugriff)' };
      return {
        ok: true,
        kind: 'wiki',
        title: `${p.icon ? `${p.icon} ` : ''}${p.title}`,
        subtitle: p.text.replace(/\s+/g, ' ').slice(0, 140),
        badge: { text: s.name, tone: 'blue' },
        fields: [
          ['Zuletzt geändert', new Date(p.updated_at).toLocaleString('de-DE', { timeZone: a.location(ctx.locationId)?.timezone || 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })],
          ['Von', p.updated_by_name || '–'],
        ],
        url: `/app/wiki/${p.id}`,
      } satisfies EmbedCard;
    });

    // --- spaces ---------------------------------------------------------------------------------------------
    router.get('/api/wiki/spaces', 'location', (ctx) => accessibleSpaces(app, ctx).map((x) => spaceOut(x.space, x.access)));
    router.post('/api/wiki/spaces', 'location', (ctx) => {
      if (ctx.scope === 'read') throw new HttpError(403, 'Diese Verbindung darf nur lesen');
      const b = ctx.body ?? {};
      const actor = actorOf(app, ctx);
      const s: SpaceRow = {
        id: id(),
        location_id: ctx.locationId,
        name: cleanName(b.name),
        icon: cleanIcon(b.icon),
        description: str(b.description, 'Beschreibung', { max: 300 }),
        team_access: cleanAccess(b.team_access),
        owner_id: actor.id,
        owner_name: actor.name,
        position: nextSpacePosition(ctx.locationId),
        created_at: now(),
        updated_at: now(),
      };
      if (Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM wiki_spaces WHERE location_id = ?', ctx.locationId)?.n) >= 50) throw bad('Höchstens 50 Bereiche je Sub-Account');
      db.insert('wiki_spaces', s);
      return spaceOut(s, spaceAccess(ctx, s) as SpaceAccess);
    });
    router.patch('/api/wiki/spaces/:id', 'location', (ctx) => {
      const { space } = loadSpace(app, ctx, ctx.params.id, 'owner');
      const b = ctx.body ?? {};
      const patch: Record<string, unknown> = { updated_at: now() };
      if (b.name !== undefined) patch.name = cleanName(b.name);
      if (b.icon !== undefined) patch.icon = cleanIcon(b.icon);
      if (b.description !== undefined) patch.description = str(b.description, 'Beschreibung', { max: 300 });
      if (b.team_access !== undefined) patch.team_access = cleanAccess(b.team_access);
      if (b.position !== undefined) patch.position = Math.max(0, Math.round(Number(b.position) || 0));
      db.update('wiki_spaces', space.id, patch, ctx.locationId);
      const s = db.get<SpaceRow>('SELECT * FROM wiki_spaces WHERE id = ?', space.id)!;
      return spaceOut(s, spaceAccess(ctx, s) as SpaceAccess);
    });
    router.delete('/api/wiki/spaces/:id', 'location', (ctx) => {
      const { space } = loadSpace(app, ctx, ctx.params.id, 'owner');
      const pages = db.all<{ id: string }>('SELECT id FROM wiki_pages WHERE space_id = ?', space.id).map((p) => p.id);
      purgeIds(app, pages);
      db.run('DELETE FROM wiki_spaces WHERE id = ?', space.id);
      return { ok: true, id: space.id, name: space.name, pages: pages.length };
    });

    // --- tree, lookups --------------------------------------------------------------------------------------
    router.get('/api/wiki/tree', 'location', (ctx) => {
      const spaces = accessibleSpaces(app, ctx);
      const ids = spaces.map((s) => s.space.id);
      const fav = favorites(ctx);
      const pages = ids.length
        ? db.all<PageRow>(`SELECT id, space_id, parent_id, position, title, icon, updated_at, updated_by_name, kb_article_id FROM wiki_pages WHERE location_id = ? AND trashed_at IS NULL AND space_id IN (${ids.map(() => '?').join(',')}) ORDER BY position, title LIMIT 5000`, ctx.locationId, ...ids)
        : [];
      return {
        spaces: spaces.map((x) => spaceOut(x.space, x.access)),
        pages: pages.map((p) => ({ id: p.id, space_id: p.space_id, parent_id: p.parent_id, position: p.position, title: p.title, icon: p.icon, updated_at: p.updated_at, updated_by_name: p.updated_by_name, favorite: fav.has(p.id), published: !!p.kb_article_id })),
      };
    });
    router.get('/api/wiki/templates', 'location', () => WIKI_TEMPLATES.map((t) => ({ key: t.key, name: t.name, description: t.description, icon: t.icon, title: t.title, pages: 1 + (t.children?.length ?? 0) })));
    router.get('/api/wiki/people', 'location', (ctx) => teamUsers(app, ctx.locationId, 'wiki').map((u) => ({ id: u.id, name: u.name, admin: u.role === 'admin' })));

    router.post('/api/wiki/render', 'location', (ctx) => {
      quiet(ctx);
      const r = renderMarkdown(cleanBody(ctx.body?.body ?? ''), { baseLevel: 2 });
      return { html: r.html, toc: r.toc };
    });
    router.post('/api/wiki/cards', 'location', async (ctx) => {
      quiet(ctx);
      const refs = Array.isArray(ctx.body?.refs) ? ctx.body.refs : [];
      return { cards: await resolveEmbeds(app, ctx, refs) };
    });

    /** Candidates for the embed picker (records, boards, documents, pages), read with the caller's rights. */
    router.get('/api/wiki/pick', 'location', (ctx) => {
      const kind = String(ctx.query.get('kind') ?? '');
      if (!(CARD_KINDS as readonly string[]).includes(kind)) throw bad('Unbekannte Art');
      const q = String(ctx.query.get('q') ?? '').trim().slice(0, 100);
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const loc = ctx.locationId;
      const probe: Record<string, string> = { contact: '/api/contacts', company: '/api/companies', deal: '/api/opportunities', task: '/api/tasks', ticket: '/api/tickets', pipeline: '/api/opportunities', canvas: '/api/canvas', doc: '/api/docs', wiki: '/api/wiki' };
      if (!probe[kind]) return [];
      if (!areaAllowed(app, ctx, probe[kind])) throw new HttpError(403, 'Kein Zugriff auf diesen Bereich');
      const eurFmt = (v: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(v || 0);
      switch (kind) {
        case 'contact':
          return db
            .all<any>(`SELECT id, first_name, last_name, email, company FROM contacts WHERE location_id = ? AND (? = '' OR (first_name || ' ' || last_name) LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT 20`, loc, q, like, like, like)
            .map((c) => ({ id: c.id, label: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Kontakt', sub: [c.company, c.email].filter(Boolean).join(' · ') }));
        case 'company':
          return db.all<any>(`SELECT id, name, domain FROM companies WHERE location_id = ? AND (? = '' OR name LIKE ? ESCAPE '\\' OR domain LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT 20`, loc, q, like, like).map((c) => ({ id: c.id, label: c.name, sub: c.domain || '' }));
        case 'deal':
          return db.all<any>(`SELECT id, name, value, status FROM opportunities WHERE location_id = ? AND (? = '' OR name LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT 20`, loc, q, like).map((o) => ({ id: o.id, label: o.name, sub: `${eurFmt(o.value)} · ${o.status}` }));
        case 'pipeline':
          return db.all<any>(`SELECT id, name FROM pipelines WHERE location_id = ? AND (? = '' OR name LIKE ? ESCAPE '\\') ORDER BY name LIMIT 20`, loc, q, like).map((p) => ({ id: p.id, label: p.name, sub: 'Pipeline' }));
        case 'task':
          return db.all<any>(`SELECT id, title, done, due_at FROM tasks WHERE location_id = ? AND (? = '' OR title LIKE ? ESCAPE '\\') ORDER BY done, created_at DESC LIMIT 20`, loc, q, like).map((t) => ({ id: t.id, label: t.title, sub: t.done ? 'erledigt' : t.due_at ? `fällig ${String(t.due_at).slice(0, 10)}` : 'offen' }));
        case 'ticket':
          return db.all<any>(`SELECT id, number, subject, status_kind FROM tickets WHERE location_id = ? AND (? = '' OR subject LIKE ? ESCAPE '\\' OR CAST(number AS TEXT) = ?) ORDER BY created_at DESC LIMIT 20`, loc, q, like, q).map((t) => ({ id: t.id, label: `#${t.number} ${t.subject}`, sub: t.status_kind }));
        case 'canvas':
          return db
            .all<BoardRow>(`SELECT * FROM canvas_boards WHERE location_id = ? AND (? = '' OR name LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT 60`, loc, q, like)
            .filter((b) => accessOf(app, ctx, b))
            .slice(0, 20)
            .map((b) => ({ id: b.id, label: b.name, sub: `${b.element_count} Elemente` }));
        case 'doc':
          return db.all<any>(`SELECT id, title, kind, source FROM docs WHERE location_id = ? AND (? = '' OR title LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT 20`, loc, q, like).map((d) => ({ id: d.id, label: d.title, sub: [d.source, d.kind].filter(Boolean).join(' · ') }));
        case 'wiki':
          return searchPages(app, ctx, q, { titlesOnly: true, limit: 20 }).map((h) => ({ id: h.id, label: `${h.icon ? `${h.icon} ` : ''}${h.title}`, sub: h.space_name }));
        default:
          return [];
      }
    });

    // --- media ------------------------------------------------------------------------------------------------
    router.post('/api/wiki/media', 'location', (ctx) => {
      if (ctx.scope === 'read') throw new HttpError(403, 'Diese Verbindung darf nur lesen');
      const name = str(ctx.body?.name, 'Dateiname', { required: true, max: 200 });
      const m = String(ctx.body?.data ?? '').match(/^data:([\w/+.-]+);base64,(.+)$/);
      if (!m) throw bad('Erwarte eine data:-URL');
      const mime = m[1];
      // No SVG or HTML: served from our own origin they could carry script.
      if (!UPLOAD_TYPES.test(mime)) throw bad('Erlaubt: Bilder (PNG, JPG, GIF, WebP), PDF, Text/CSV, Office-Dokumente und ZIP');
      const buf = Buffer.from(m[2], 'base64');
      if (!buf.length) throw bad('Die Datei ist leer');
      if (buf.length > 8 * 1024 * 1024) throw bad('Datei größer als 8 MB');
      if (!contentMatches(mime, buf)) throw bad('Dateiinhalt passt nicht zum Dateityp');
      mkdirSync(uploadDir, { recursive: true });
      const file = `${id(20)}${extFor(mime)}`;
      writeFileSync(join(uploadDir, file), buf);
      const row = { id: id(), location_id: ctx.locationId, name: name.slice(0, 200), file, mime, size: buf.length, created_at: now() };
      db.insert('uploads', row);
      const image = mime.startsWith('image/');
      const src = `/uploads/${file}`;
      const label = name.replace(/[\][\n]/g, ' ');
      return { id: row.id, name: row.name, mime, size: buf.length, src, url: `${app.baseUrl()}${src}`, image, markdown: image ? `![${label}](${src})` : `[${label}](${src})` };
    });

    // --- search / lists -------------------------------------------------------------------------------------------
    router.get('/api/wiki/search', 'location', (ctx) => searchPages(app, ctx, String(ctx.query.get('q') ?? ''), { spaceId: ctx.query.get('space_id') || undefined, limit: Number(ctx.query.get('limit')) || 20, titlesOnly: ctx.query.get('titles') === '1' }));

    router.get('/api/wiki/favorites', 'location', (ctx) => {
      if (!ctx.user || ctx.viaApiKey) return [];
      return db
        .all<PageRow>(`SELECT p.* FROM wiki_favorites f JOIN wiki_pages p ON p.id = f.page_id WHERE f.user_id = ? AND f.location_id = ? AND p.trashed_at IS NULL ORDER BY f.created_at DESC LIMIT 100`, ctx.user.id, ctx.locationId)
        .filter((p) => {
          const s = db.get<SpaceRow>('SELECT * FROM wiki_spaces WHERE id = ?', p.space_id);
          return !!s && !!spaceAccess(ctx, s);
        })
        .map((p) => ({ id: p.id, title: p.title, icon: p.icon, space_id: p.space_id, updated_at: p.updated_at }));
    });

    router.get('/api/wiki/trash', 'location', (ctx) => {
      const spaces = new Map(accessibleSpaces(app, ctx).filter((x) => x.access !== 'view').map((x) => [x.space.id, x.space.name]));
      if (!spaces.size) return [];
      // only the roots of deleted branches (a page whose parent is in the trash too comes back with it)
      return db
        .all<PageRow>(`SELECT p.* FROM wiki_pages p WHERE p.location_id = ? AND p.trashed_at IS NOT NULL AND p.space_id IN (${[...spaces.keys()].map(() => '?').join(',')}) AND NOT EXISTS (SELECT 1 FROM wiki_pages q WHERE q.id = p.parent_id AND q.trashed_at IS NOT NULL) ORDER BY p.trashed_at DESC LIMIT 200`, ctx.locationId, ...spaces.keys())
        .map((p) => ({ id: p.id, title: p.title, icon: p.icon, space_id: p.space_id, space_name: spaces.get(p.space_id), trashed_at: p.trashed_at, pages: subtreeIds(app, p.id).length }));
    });

    // --- pages -----------------------------------------------------------------------------------------------------
    router.post('/api/wiki/pages', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const spaceId = str(b.space_id, 'Bereich', { required: true, max: 40 });
      const { space } = loadSpace(app, ctx, spaceId, 'edit');
      const tpl = b.template ? templateByKey(String(b.template)) : undefined;
      if (b.template && !tpl) throw bad('Unbekannte Vorlage');
      const vars = { datum: new Date().toLocaleDateString('de-DE', { timeZone: app.location(ctx.locationId)?.timezone || 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' }), autor: actorOf(app, ctx).name, projekt: app.location(ctx.locationId)?.name ?? '' };
      const page = createPage(app, ctx, {
        spaceId: space.id,
        parentId: b.parent_id || null,
        beforeId: b.before_id || null,
        title: b.title !== undefined ? b.title : tpl ? fillTemplate(tpl.title, vars) : undefined,
        body: b.body !== undefined ? b.body : tpl ? fillTemplate(tpl.body, vars) : '',
        icon: b.icon !== undefined ? b.icon : tpl?.icon,
      });
      for (const c of tpl?.children ?? []) createPage(app, ctx, { spaceId: space.id, parentId: page.id, title: fillTemplate(c.title, vars), body: fillTemplate(c.body, vars), icon: c.icon });
      return pageOut(ctx, page, space, spaceAccess(ctx, space) as SpaceAccess);
    });

    router.post('/api/wiki/import', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const { space } = loadSpace(app, ctx, str(b.space_id, 'Bereich', { required: true, max: 40 }), 'edit');
      const files: { name: string; content: string }[] = Array.isArray(b.files) ? b.files : typeof b.markdown === 'string' ? [{ name: String(b.title ?? 'Import'), content: b.markdown }] : [];
      if (!files.length) throw bad('Keine Dateien übergeben');
      if (files.length > IMPORT_LIMITS.files) throw bad(`Höchstens ${IMPORT_LIMITS.files} Dateien auf einmal`);
      const parent = b.parent_id ? String(b.parent_id) : null;
      const out: ReturnType<typeof pageOut>[] = [];
      for (const f of files) {
        let content = String(f?.content ?? '');
        if (content.length > IMPORT_LIMITS.bytes) throw bad(`„${String(f?.name ?? '').slice(0, 60)}“ ist größer als 1 MB`);
        const fileName = String(f?.name ?? 'Import').replace(/\.(md|markdown|txt|html?)$/i, '').slice(0, 200);
        if (/\.html?$/i.test(String(f?.name ?? '')) || /^\s*<(!doctype|html|body|h1|h2|p|div)\b/i.test(content)) content = htmlToMarkdown(content);
        content = content.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
        let title = '';
        // front matter: only its title is used, the rest is dropped
        const fm = /^---\n([\s\S]{0,4000}?)\n---\n?/.exec(content);
        if (fm) {
          title = /^title:\s*["']?(.+?)["']?\s*$/im.exec(fm[1])?.[1] ?? '';
          content = content.slice(fm[0].length);
        }
        const h = firstHeading(content);
        if (h) {
          title ||= h;
          // the first "# heading" becomes the page title
          content = content.replace(/^\s*#[ \t]+.*\n?/, '');
        }
        const page = createPage(app, ctx, { spaceId: space.id, parentId: parent, title: title || fileName || 'Import', body: content.trim(), via: 'import', note: 'Import' });
        out.push(pageOut(ctx, page, space, spaceAccess(ctx, space) as SpaceAccess, false));
      }
      return { imported: out.length, pages: out };
    });

    router.get('/api/wiki/pages/:id', 'location', (ctx) => {
      const { page, space, access } = loadPage(app, ctx, ctx.params.id);
      return pageOut(ctx, page, space, access);
    });
    /** Cheap poll while a page is open: has somebody else saved? */
    router.get('/api/wiki/pages/:id/version', 'location', (ctx) => {
      const { page } = loadPage(app, ctx, ctx.params.id);
      return { version: page.version, updated_at: page.updated_at, updated_by_name: page.updated_by_name };
    });

    router.patch('/api/wiki/pages/:id', 'location', (ctx) => {
      const { page, space, access } = loadPage(app, ctx, ctx.params.id, 'edit');
      const b = ctx.body ?? {};
      const fresh = updatePage(app, ctx, page, space, { title: b.title, body: b.body, icon: b.icon }, { baseVersion: b.base_version !== undefined ? Number(b.base_version) : undefined, force: b.force === true, note: typeof b.note === 'string' ? b.note.slice(0, 200) : undefined });
      if (fresh !== page) {
        quiet(ctx);
        const key = `${ctx.user?.id ?? ctx.via}:${page.id}`;
        if (Date.now() - (lastAudit.get(key) ?? 0) > 10 * 60_000 || fresh.title !== page.title) {
          lastAudit.set(key, Date.now());
          if (lastAudit.size > 5000) lastAudit.clear();
          app.services.audit?.({ ctx, action: 'wiki.edit', route: 'PATCH /api/wiki/pages/:id', entityId: page.id, summary: `Seite „${fresh.title}“ bearbeitet` });
        }
      } else quiet(ctx);
      return pageOut(ctx, fresh, space, access);
    });

    router.delete('/api/wiki/pages/:id', 'location', (ctx) => {
      const { page } = loadPage(app, ctx, ctx.params.id, 'edit', { trashed: true });
      if (ctx.query.get('purge') === '1') {
        if (!page.trashed_at) throw bad('Nur Seiten aus dem Papierkorb können endgültig gelöscht werden');
        const ids = subtreeIds(app, page.id);
        purgeIds(app, ids);
        return { ok: true, id: page.id, title: page.title, purged: ids.length };
      }
      if (page.trashed_at) return { ok: true, id: page.id, title: page.title, pages: 0 };
      const ids = trashPage(app, page);
      return { ok: true, id: page.id, title: page.title, pages: ids.length };
    });
    router.post('/api/wiki/pages/:id/restore', 'location', (ctx) => {
      const { page, space, access } = loadPage(app, ctx, ctx.params.id, 'edit', { trashed: true });
      if (!page.trashed_at) throw bad('Die Seite liegt nicht im Papierkorb');
      return pageOut(ctx, restorePage(app, page), space, access, false);
    });

    router.post('/api/wiki/pages/:id/move', 'location', (ctx) => {
      const { page } = loadPage(app, ctx, ctx.params.id, 'edit');
      const b = ctx.body ?? {};
      const moved = movePage(app, ctx, page, { spaceId: b.space_id ? String(b.space_id) : undefined, parentId: b.parent_id === undefined ? undefined : b.parent_id ? String(b.parent_id) : null, beforeId: b.before_id ? String(b.before_id) : null });
      const space = db.get<SpaceRow>('SELECT * FROM wiki_spaces WHERE id = ?', moved.space_id)!;
      return pageOut(ctx, moved, space, spaceAccess(ctx, space) as SpaceAccess, false);
    });

    router.post('/api/wiki/pages/:id/duplicate', 'location', (ctx) => {
      const { page, space } = loadPage(app, ctx, ctx.params.id, 'edit');
      const withChildren = ctx.body?.children === true;
      const copy = (src: PageRow, parentId: string | null, title?: string, beforeId?: string | null): PageRow => {
        const c = createPage(app, ctx, { spaceId: space.id, parentId, beforeId, title: title ?? src.title, body: src.body, icon: src.icon, note: 'Kopie' });
        if (withChildren) for (const child of db.all<PageRow>('SELECT * FROM wiki_pages WHERE parent_id = ? AND trashed_at IS NULL ORDER BY position LIMIT 200', src.id)) copy(child, c.id);
        return c;
      };
      // right below the original
      const next = db.get<{ id: string }>('SELECT id FROM wiki_pages WHERE space_id = ? AND parent_id IS ? AND trashed_at IS NULL AND position > ? ORDER BY position LIMIT 1', page.space_id, page.parent_id, page.position);
      const c = copy(page, page.parent_id, `${page.title} (Kopie)`.slice(0, LIMITS.title), next?.id ?? null);
      return pageOut(ctx, c, space, spaceAccess(ctx, space) as SpaceAccess, false);
    });

    router.post('/api/wiki/pages/:id/toggle', 'location', (ctx) => {
      const { page, space, access } = loadPage(app, ctx, ctx.params.id, 'edit');
      const b = ctx.body ?? {};
      if (Number(b.base_version) !== page.version) throw new HttpError(409, 'Die Seite wurde inzwischen geändert – bitte neu laden.');
      const body = toggleTask(page.body, Number(b.line), b.checked === true);
      if (body === null) throw bad('Dort steht keine Checkliste');
      const fresh = updatePage(app, ctx, page, space, { body }, { via: 'toggle' });
      quiet(ctx);
      return pageOut(ctx, fresh, space, access);
    });

    // --- versions ----------------------------------------------------------------------------------------------------
    router.get('/api/wiki/pages/:id/versions', 'location', (ctx) => {
      const { page } = loadPage(app, ctx, ctx.params.id);
      return db.all(`SELECT id, rev, title, author_name, via, note, created_at, saved_at, LENGTH(body) AS size FROM wiki_versions WHERE page_id = ? ORDER BY rev DESC LIMIT ${LIMITS.versionsPerPage}`, page.id).map((v: any, i: number) => ({ ...v, current: i === 0 }));
    });
    router.get('/api/wiki/pages/:id/versions/:vid', 'location', (ctx) => {
      const { page, access } = loadPage(app, ctx, ctx.params.id);
      const v = db.get<any>('SELECT * FROM wiki_versions WHERE id = ? AND page_id = ?', ctx.params.vid, page.id);
      if (!v) throw notFound('Version nicht gefunden');
      const r = renderMarkdown(v.body, { baseLevel: 2 });
      return {
        id: v.id,
        rev: v.rev,
        title: v.title,
        body: v.body,
        html: r.html,
        author_name: v.author_name,
        via: v.via,
        note: v.note,
        created_at: v.created_at,
        saved_at: v.saved_at,
        access,
        diff: ctx.query.get('diff') === '1' ? lineDiff(v.body, page.body).map((d) => ({ t: d.t, text: d.text.slice(0, 2000) })) : undefined,
      };
    });
    router.post('/api/wiki/pages/:id/versions/:vid/restore', 'location', (ctx) => {
      const { page, space, access } = loadPage(app, ctx, ctx.params.id, 'edit');
      const fresh = restoreVersion(app, ctx, page, space, ctx.params.vid);
      return pageOut(ctx, fresh, space, access);
    });

    // --- comments ---------------------------------------------------------------------------------------------------------
    const commentOut = (c: any) => ({ ...c, mentions: JSON.parse(c.mentions || '[]'), html: renderChat(c.body) });
    router.get('/api/wiki/pages/:id/comments', 'location', (ctx) => {
      const { page } = loadPage(app, ctx, ctx.params.id);
      return db.all('SELECT * FROM wiki_comments WHERE page_id = ? ORDER BY created_at LIMIT 1000', page.id).map(commentOut);
    });
    router.post('/api/wiki/pages/:id/comments', 'location', (ctx) => {
      const { page, space } = loadPage(app, ctx, ctx.params.id);
      const b = ctx.body ?? {};
      const actor = actorOf(app, ctx);
      const body = str(b.body, 'Kommentar', { required: true, max: 5000 });
      let parent: any;
      if (b.parent_id) {
        parent = db.get('SELECT * FROM wiki_comments WHERE id = ? AND page_id = ?', String(b.parent_id), page.id);
        if (!parent) throw notFound('Kommentar nicht gefunden');
      }
      // mentions: "[@Name](user:ID)" from the picker, or a plain "@Name" (API, agents)
      const team = teamUsers(app, ctx.locationId, 'wiki').filter((u) => spaceAccess(asUser(ctx, u), space));
      const mentioned = new Set(extractRefs(body).users.filter((u) => team.some((t) => t.id === u)));
      const lower = body.toLowerCase();
      for (const u of team) if (u.name && lower.includes(`@${u.name.toLowerCase()}`)) mentioned.add(u.id);
      const row = { id: id(), page_id: page.id, location_id: ctx.locationId, parent_id: parent?.id ?? null, body, quote: str(b.quote, 'Zitat', { max: 300 }), mentions: JSON.stringify([...mentioned]), author_id: actor.id, author_name: actor.name, via: String(ctx.via ?? ''), resolved_at: null, created_at: now(), updated_at: now() };
      db.insert('wiki_comments', row);
      // who hears about it: mentioned people, the page's author, the author of the comment replied to
      const notify = new Set<string>([...mentioned]);
      if (page.created_by) notify.add(page.created_by);
      if (parent?.author_id) notify.add(parent.author_id);
      notify.delete(actor.id ?? '');
      const targets = [...notify].filter((uid) => team.some((t) => t.id === uid));
      if (targets.length && app.services.pushNotify) {
        track(app, Promise.resolve(app.services.pushNotify({ userIds: targets, kind: 'wiki', title: `${actor.name} hat „${page.title}“ kommentiert`.slice(0, 120), body: markdownToText(body).slice(0, 200), url: `/app/wiki/${page.id}?comment=${row.id}`, tag: `wiki-c:${row.id}` })));
      }
      return { ...commentOut(row), notified: targets.length };
    });
    router.patch('/api/wiki/pages/:id/comments/:cid', 'location', (ctx) => {
      const { page, access } = loadPage(app, ctx, ctx.params.id);
      const c = db.get<any>('SELECT * FROM wiki_comments WHERE id = ? AND page_id = ?', ctx.params.cid, page.id);
      if (!c) throw notFound('Kommentar nicht gefunden');
      const actor = actorOf(app, ctx);
      const mine = !!actor.id && c.author_id === actor.id;
      const patch: Record<string, unknown> = { updated_at: now() };
      if (ctx.body?.body !== undefined) {
        if (!mine) throw new HttpError(403, 'Nur eigene Kommentare bearbeiten');
        patch.body = str(ctx.body.body, 'Kommentar', { required: true, max: 5000 });
      }
      if (ctx.body?.resolved !== undefined) {
        if (!mine && access === 'view') throw new HttpError(403, 'Nur Lesezugriff auf diesen Bereich');
        patch.resolved_at = ctx.body.resolved ? now() : null;
      }
      db.update('wiki_comments', c.id, patch);
      return commentOut(db.get('SELECT * FROM wiki_comments WHERE id = ?', c.id));
    });
    router.delete('/api/wiki/pages/:id/comments/:cid', 'location', (ctx) => {
      const { page, access } = loadPage(app, ctx, ctx.params.id);
      const c = db.get<any>('SELECT * FROM wiki_comments WHERE id = ? AND page_id = ?', ctx.params.cid, page.id);
      if (!c) throw notFound('Kommentar nicht gefunden');
      const actor = actorOf(app, ctx);
      if (!(actor.id && c.author_id === actor.id) && access !== 'owner') throw new HttpError(403, 'Nur eigene Kommentare löschen');
      db.run('DELETE FROM wiki_comments WHERE (id = ? OR parent_id = ?) AND page_id = ?', c.id, c.id, page.id);
      return { ok: true };
    });

    // --- favourites ----------------------------------------------------------------------------------------------------------
    router.post('/api/wiki/pages/:id/favorite', 'location', (ctx) => {
      const { page } = loadPage(app, ctx, ctx.params.id);
      if (!ctx.user || isBot(ctx)) throw bad('Favoriten gibt es nur mit Anmeldung');
      db.run('INSERT OR IGNORE INTO wiki_favorites (user_id, page_id, location_id, created_at) VALUES (?, ?, ?, ?)', ctx.user.id, page.id, ctx.locationId, now());
      return { ok: true, favorite: true };
    });
    router.delete('/api/wiki/pages/:id/favorite', 'location', (ctx) => {
      const { page } = loadPage(app, ctx, ctx.params.id);
      if (ctx.user && !isBot(ctx)) db.run('DELETE FROM wiki_favorites WHERE user_id = ? AND page_id = ?', ctx.user.id, page.id);
      return { ok: true, favorite: false };
    });

    // --- share links (public, read-only, revocable) ------------------------------------------------------------------------------
    const shareOut = (s: any) => ({ id: s.id, label: s.label, created_by: s.created_by, created_at: s.created_at, revoked_at: s.revoked_at, last_used_at: s.last_used_at, views: s.views, url: s.revoked_at ? null : `${app.baseUrl()}/wiki/s/${openIfSealed(app, s.token_sealed)}` });
    router.get('/api/wiki/pages/:id/shares', 'location', (ctx) => {
      const { page } = loadPage(app, ctx, ctx.params.id, 'edit');
      return db.all('SELECT * FROM wiki_shares WHERE page_id = ? ORDER BY created_at DESC', page.id).map(shareOut);
    });
    router.post('/api/wiki/pages/:id/shares', 'location', (ctx) => {
      const { page } = loadPage(app, ctx, ctx.params.id, 'edit');
      if (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM wiki_shares WHERE page_id = ? AND revoked_at IS NULL', page.id)!.n >= 10) throw bad('Höchstens 10 aktive Links je Seite');
      const tok = token(24);
      const row = { id: id(), page_id: page.id, location_id: ctx.locationId, token_hash: sha256(tok), token_sealed: sealSecret(app, tok), label: str(ctx.body?.label, 'Bezeichnung', { max: 120 }), created_by: actorOf(app, ctx).name.slice(0, 200), created_at: now(), revoked_at: null, last_used_at: null, views: 0 };
      db.insert('wiki_shares', row);
      return { ...shareOut(row), title: page.title };
    });
    router.delete('/api/wiki/pages/:id/shares/:sid', 'location', (ctx) => {
      const { page } = loadPage(app, ctx, ctx.params.id, 'edit');
      if (!db.run('UPDATE wiki_shares SET revoked_at = ? WHERE id = ? AND page_id = ? AND revoked_at IS NULL', now(), ctx.params.sid, page.id).changes) throw notFound('Link nicht gefunden');
      return { ok: true, id: ctx.params.sid, title: page.title };
    });

    // --- upsert for agents and scripts -----------------------------------------------------------------------------------------------
    /** Page by id, or by title within a space/parent; created when missing. `mode: append` adds to the end. */
    router.post('/api/wiki/upsert', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const title = b.title !== undefined ? cleanTitle(b.title) : undefined;
      let space: SpaceRow | undefined;
      let page: PageRow | undefined;
      if (b.page_id) {
        const l = loadPage(app, ctx, String(b.page_id), 'edit');
        page = l.page;
        space = l.space;
      } else {
        if (!title) throw bad('title oder page_id fehlt');
        const wanted = String(b.space_id ?? b.space ?? '').trim();
        const visible = accessibleSpaces(app, ctx);
        const found = wanted ? visible.find((x) => x.space.id === wanted || x.space.name.toLowerCase() === wanted.toLowerCase()) : visible.find((x) => x.access !== 'view');
        if (found) space = loadSpace(app, ctx, found.space.id, 'edit').space;
        else {
          if (b.create_space === false) throw notFound('Bereich nicht gefunden');
          const actor = actorOf(app, ctx);
          const s: SpaceRow = { id: id(), location_id: ctx.locationId, name: cleanName(wanted || 'Team-Wiki'), icon: '', description: '', team_access: 'edit', owner_id: actor.id, owner_name: actor.name, position: nextSpacePosition(ctx.locationId), created_at: now(), updated_at: now() };
          db.insert('wiki_spaces', s);
          space = s;
        }
        const parentId = b.parent_id ? String(b.parent_id) : null;
        page = db.get<PageRow>('SELECT * FROM wiki_pages WHERE space_id = ? AND parent_id IS ? AND trashed_at IS NULL AND LOWER(title) = LOWER(?) LIMIT 1', space.id, parentId, title);
        if (!page) {
          const created = createPage(app, ctx, { spaceId: space.id, parentId, title, body: b.body ?? '', icon: b.icon, note: typeof b.note === 'string' ? b.note.slice(0, 200) : undefined });
          return { created: true, ...(pageOut(ctx, created, space, spaceAccess(ctx, space) as SpaceAccess) as object) };
        }
      }
      let body: string | undefined;
      if (b.body !== undefined) body = b.mode === 'append' ? `${page.body.replace(/\s+$/, '')}\n\n${cleanBody(b.body)}`.trim() : cleanBody(b.body);
      const fresh = updatePage(app, ctx, page, space!, { title: b.page_id ? b.title : undefined, body, icon: b.icon }, { baseVersion: b.base_version !== undefined ? Number(b.base_version) : undefined, note: typeof b.note === 'string' ? b.note.slice(0, 200) : undefined });
      return { created: false, ...(pageOut(ctx, fresh, space!, spaceAccess(ctx, space!) as SpaceAccess) as object) };
    });

    // --- export ------------------------------------------------------------------------------------------------------------------------------
    router.get('/api/wiki/pages/:id/export', 'location', async (ctx) => {
      const { page, space } = loadPage(app, ctx, ctx.params.id);
      const format = String(ctx.query.get('format') ?? 'md');
      const withChildren = ctx.query.get('children') === '1';
      const pages: PageRow[] = [page];
      if (withChildren) {
        const walk = (pid: string, depth: number) => {
          if (depth > 8 || pages.length > 200) return;
          for (const c of db.all<PageRow>('SELECT * FROM wiki_pages WHERE parent_id = ? AND trashed_at IS NULL ORDER BY position, title', pid)) {
            pages.push(c);
            walk(c.id, depth + 1);
          }
        };
        walk(page.id, 0);
      }
      const base = app.baseUrl();
      const fname = slugify(page.title) || 'seite';
      if (format === 'md') {
        const md = pages.map((p) => `# ${p.title}\n\n${portableMarkdown(p.body, base)}`.trimEnd()).join('\n\n---\n\n');
        const r = text(`${md}\n`, 'text/markdown; charset=utf-8');
        r.headers['content-disposition'] = `attachment; filename="${fname}.md"`;
        r.headers['cache-control'] = 'no-store';
        return r;
      }
      if (format === 'pdf') {
        const make = app.services.wikiPdf as ((a: unknown, p: PageRow[], opts: { space: string; baseUrl: string; author: string }) => Uint8Array) | undefined;
        if (!make) throw new HttpError(501, 'PDF-Export ist nicht verfügbar');
        const bytes = make(app, pages, { space: space.name, baseUrl: base, author: page.updated_by_name });
        return { __raw: true, status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${fname}.pdf"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: Buffer.from(bytes) };
      }
      throw bad('format: md oder pdf');
    });

    // --- housekeeping ---------------------------------------------------------------------------------------------------------------------------
    let lastPurge = 0;
    app.onTick(() => {
      if (Date.now() - lastPurge < 6 * 3600_000) return;
      lastPurge = Date.now();
      // the trash is emptied after 30 days
      const old = db.all<{ id: string }>('SELECT id FROM wiki_pages WHERE trashed_at IS NOT NULL AND trashed_at < ? LIMIT 500', new Date(Date.now() - 30 * 864e5).toISOString()).map((p) => p.id);
      purgeIds(app, old);
    });
    // lets tests (and a clean shutdown) wait for notifications that are sent in the background
    app.services.collabIdle = async () => {
      for (let i = 0; i < 20 && app.services.collabPending?.size; i++) await Promise.allSettled([...app.services.collabPending]);
    };
  },
};
