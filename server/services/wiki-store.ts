import type { App } from '../core/app.js';
import { HttpError, bad, notFound, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { actorOf, asUser, track, userById, type Actor, type TeamUser } from './collab-actor.js';
import { HIT_END, HIT_START, likePattern, matchExpr, plainSnippet, searchWords, type Fts } from './collab-fts.js';
import { MAX_SOURCE, extractRefs, markdownToText } from './wiki-markdown.js';

/**
 * Data rules of the Wiki: access to spaces, the page tree (nesting, order, moving, trash), saving with
 * version history and conflict detection, search. Routes (modules/wiki.ts) stay thin; the MCP tools, the
 * mobile API and the AI helper use the same functions.
 */

export interface SpaceRow {
  id: string;
  location_id: string;
  name: string;
  icon: string;
  description: string;
  team_access: 'edit' | 'view' | 'none';
  owner_id: string | null;
  owner_name: string;
  position: number;
  created_at: string;
  updated_at: string;
}
export interface PageRow {
  id: string;
  location_id: string;
  space_id: string;
  parent_id: string | null;
  position: number;
  title: string;
  icon: string;
  body: string;
  text: string;
  version: number;
  trashed_at: string | null;
  kb_article_id: string | null;
  kb_version: number | null;
  created_by: string | null;
  created_by_name: string;
  updated_by: string | null;
  updated_by_name: string;
  created_at: string;
  updated_at: string;
}
export type SpaceAccess = 'owner' | 'edit' | 'view';
const RANK: Record<SpaceAccess, number> = { view: 1, edit: 2, owner: 3 };

export const LIMITS = { pagesPerLocation: 5000, depth: 12, versionsPerPage: 150, coalesceMs: 10 * 60_000, title: 200 };

export const fts = (app: App): Fts => app.services.wikiFts as Fts;

// --- access ------------------------------------------------------------------------------------------

/** Keys and MCP connections of the sub-account edit everywhere (read-only keys view); people get the space's team access. */
export function spaceAccess(ctx: Ctx, s: SpaceRow): SpaceAccess | null {
  if (ctx.viaApiKey) return ctx.scope === 'read' ? 'view' : 'edit';
  const u = ctx.user;
  if (!u) return null;
  if (u.role === 'admin' || s.owner_id === u.id) return 'owner';
  return s.team_access === 'edit' ? 'edit' : s.team_access === 'view' ? 'view' : null;
}

const needMessage = (need: SpaceAccess) => (need === 'owner' ? 'Nur die Besitzerin/der Besitzer des Bereichs (oder die Agentur) darf das' : 'Dieser Bereich ist für dich nur lesbar');

/** The space if the caller may use it at the needed level (404 without any access – never a hint that it exists). */
export function loadSpace(app: App, ctx: Ctx, spaceId: string, need: SpaceAccess = 'view'): { space: SpaceRow; access: SpaceAccess } {
  const s = app.db.get<SpaceRow>('SELECT * FROM wiki_spaces WHERE id = ? AND location_id = ?', String(spaceId), ctx.locationId);
  const access = s ? spaceAccess(ctx, s) : null;
  if (!s || !access) throw notFound('Bereich nicht gefunden');
  if (RANK[access] < RANK[need]) throw new HttpError(403, needMessage(need));
  return { space: s, access };
}

export function loadPage(app: App, ctx: Ctx, pageId: string, need: SpaceAccess = 'view', opts: { trashed?: boolean } = {}): { page: PageRow; space: SpaceRow; access: SpaceAccess } {
  const p = app.db.get<PageRow>('SELECT * FROM wiki_pages WHERE id = ? AND location_id = ?', String(pageId), ctx.locationId);
  if (!p || (p.trashed_at && !opts.trashed)) throw notFound('Seite nicht gefunden');
  const { space, access } = loadSpace(app, ctx, p.space_id, need);
  return { page: p, space, access };
}

/** May this person use the wiki of the sub-account at all (member rights)? */
export const mayUseWiki = (u: TeamUser, locationId: string) => u.role === 'admin' || (u.locations.includes(locationId) && (!u.permissions || u.permissions.includes('wiki')));

/** Spaces the caller may open, with their access. */
export function accessibleSpaces(app: App, ctx: Ctx): { space: SpaceRow; access: SpaceAccess }[] {
  return app.db
    .all<SpaceRow>('SELECT * FROM wiki_spaces WHERE location_id = ? ORDER BY position, name', ctx.locationId)
    .map((space) => ({ space, access: spaceAccess(ctx, space) as SpaceAccess }))
    .filter((x) => x.access);
}

// --- tree ----------------------------------------------------------------------------------------------

const siblings = (app: App, spaceId: string, parentId: string | null, exclude?: string): PageRow[] =>
  app.db.all<PageRow>(`SELECT * FROM wiki_pages WHERE space_id = ? AND parent_id IS ? AND trashed_at IS NULL ${exclude ? 'AND id != ?' : ''} ORDER BY position, title`, spaceId, parentId, ...(exclude ? [exclude] : []));

/** Ancestors of a page, root first (at most 20). */
export function pagePath(app: App, page: PageRow): { id: string; title: string; icon: string }[] {
  const out: { id: string; title: string; icon: string }[] = [];
  let cur = page.parent_id;
  for (let i = 0; cur && i < 20; i++) {
    const p = app.db.get<PageRow>('SELECT id, title, icon, parent_id FROM wiki_pages WHERE id = ?', cur);
    if (!p) break;
    out.unshift({ id: p.id, title: p.title, icon: p.icon });
    cur = p.parent_id;
  }
  return out;
}

const depthOf = (app: App, parentId: string | null): number => {
  let d = 0;
  for (let cur = parentId; cur && d < 40; d++) cur = app.db.get<{ parent_id: string | null }>('SELECT parent_id FROM wiki_pages WHERE id = ?', cur)?.parent_id ?? null;
  return d;
};

/** Ids of a page and everything below it. */
export function subtreeIds(app: App, pageId: string): string[] {
  return app.db.all<{ id: string }>(`WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT p.id FROM wiki_pages p JOIN t ON p.parent_id = t.id) SELECT id FROM t LIMIT 5000`, pageId).map((r) => r.id);
}
const subtreeDepth = (app: App, pageId: string): number =>
  Number(app.db.get<{ d: number }>(`WITH RECURSIVE t(id, d) AS (SELECT ?, 0 UNION ALL SELECT p.id, t.d + 1 FROM wiki_pages p JOIN t ON p.parent_id = t.id WHERE t.d < 40) SELECT MAX(d) AS d FROM t`, pageId)?.d ?? 0);

function renumber(app: App, list: { id: string }[]) {
  list.forEach((p, i) => app.db.run('UPDATE wiki_pages SET position = ? WHERE id = ? AND position != ?', i, p.id, i));
}

// --- indexing ------------------------------------------------------------------------------------------

export function indexPage(app: App, p: PageRow) {
  const r = app.db.get<{ r: number }>('SELECT rowid AS r FROM wiki_pages WHERE id = ?', p.id);
  if (!r) return;
  if (p.trashed_at) fts(app).remove(r.r);
  else fts(app).upsert(r.r, { title: p.title, body: p.text });
}
export function unindexIds(app: App, ids: string[]) {
  for (const pid of ids) {
    const r = app.db.get<{ r: number }>('SELECT rowid AS r FROM wiki_pages WHERE id = ?', pid);
    if (r) fts(app).remove(r.r);
  }
}

// --- create / save ---------------------------------------------------------------------------------------

const cleanTitle = (v: unknown, fallback = 'Neue Seite') => {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (t.length > LIMITS.title) throw bad(`Titel ist zu lang (höchstens ${LIMITS.title} Zeichen)`);
  return t || fallback;
};
const cleanIcon = (v: unknown) => {
  const s = String(v ?? '').trim();
  return s.length <= 8 && !/[<>"'&\\]/.test(s) ? s : '';
};
const cleanBody = (v: unknown) => {
  const s = String(v ?? '').replace(/\r\n?/g, '\n');
  if (s.length > MAX_SOURCE) throw bad(`Die Seite ist zu lang (höchstens ${MAX_SOURCE.toLocaleString('de-DE')} Zeichen)`);
  return s;
};
export { cleanTitle, cleanBody, cleanIcon };

export interface NewPage {
  spaceId: string;
  parentId?: string | null;
  beforeId?: string | null;
  title?: string;
  body?: string;
  icon?: string;
  via?: string;
  note?: string;
}

export function createPage(app: App, ctx: Ctx, input: NewPage): PageRow {
  const { space } = loadSpace(app, ctx, input.spaceId, 'edit');
  const actor = actorOf(app, ctx);
  if ((app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM wiki_pages WHERE location_id = ?', ctx.locationId)?.n ?? 0) >= LIMITS.pagesPerLocation) throw bad(`Höchstens ${LIMITS.pagesPerLocation} Seiten je Sub-Account`);
  let parent: PageRow | undefined;
  if (input.parentId) {
    parent = app.db.get<PageRow>('SELECT * FROM wiki_pages WHERE id = ? AND space_id = ? AND trashed_at IS NULL', String(input.parentId), space.id);
    if (!parent) throw bad('Übergeordnete Seite nicht gefunden');
    if (depthOf(app, parent.id) + 1 >= LIMITS.depth) throw bad(`Höchstens ${LIMITS.depth} Ebenen`);
  }
  const body = cleanBody(input.body ?? '');
  const page: PageRow = {
    id: id(),
    location_id: ctx.locationId,
    space_id: space.id,
    parent_id: parent?.id ?? null,
    position: 0,
    title: cleanTitle(input.title),
    icon: cleanIcon(input.icon),
    body,
    text: markdownToText(body),
    version: 1,
    trashed_at: null,
    kb_article_id: null,
    kb_version: null,
    created_by: actor.id,
    created_by_name: actor.name,
    updated_by: actor.id,
    updated_by_name: actor.name,
    created_at: now(),
    updated_at: now(),
  };
  app.db.tx(() => {
    app.db.insert('wiki_pages', page);
    const sibs = siblings(app, space.id, page.parent_id, page.id);
    const at = input.beforeId ? sibs.findIndex((s) => s.id === input.beforeId) : -1;
    sibs.splice(at < 0 ? sibs.length : at, 0, page);
    renumber(app, sibs);
    app.db.insert('wiki_versions', { id: id(), page_id: page.id, location_id: ctx.locationId, rev: 1, title: page.title, body, author_id: actor.id, author_name: actor.name, via: input.via ?? String(ctx.via ?? ''), note: input.note ?? '', created_at: now(), saved_at: now() });
  });
  const fresh = app.db.get<PageRow>('SELECT * FROM wiki_pages WHERE id = ?', page.id)!;
  indexPage(app, fresh);
  notifyMentions(app, ctx, fresh, space, '');
  app.db.run('UPDATE wiki_spaces SET updated_at = ? WHERE id = ?', now(), space.id);
  return fresh;
}

/** Names who was mentioned for the first time on a page and tells them (push). */
export function notifyMentions(app: App, ctx: Ctx, page: PageRow, space: SpaceRow, oldBody: string, extra?: { body: string; url?: string; what?: string }) {
  const actor = actorOf(app, ctx);
  const before = new Set(extractRefs(oldBody).users);
  const ids = extractRefs(extra?.body ?? page.body).users.filter((u) => !before.has(u) && u !== actor.id);
  if (!ids.length) return [];
  const notify: string[] = [];
  for (const uid of ids.slice(0, 20)) {
    const u = userById(app, uid);
    if (u && mayUseWiki(u, page.location_id) && spaceAccess(asUser(ctx, u), space)) notify.push(uid);
  }
  if (notify.length && app.services.pushNotify) {
    const text = markdownToText(extra?.body ?? page.body).replace(/\s+/g, ' ').slice(0, 200);
    track(app, Promise.resolve(app.services.pushNotify({ userIds: notify, kind: 'wiki', title: `${actor.name} hat dich ${extra?.what ?? 'in'} „${page.title}“ erwähnt`.slice(0, 120), body: text, url: extra?.url ?? `/app/wiki/${page.id}`, tag: `wiki:${page.id}` })));
  }
  return notify;
}

export interface Patch {
  title?: unknown;
  body?: unknown;
  icon?: unknown;
}

export function updatePage(app: App, ctx: Ctx, page: PageRow, space: SpaceRow, patch: Patch, opts: { baseVersion?: number; force?: boolean; note?: string; via?: string } = {}): PageRow {
  const actor = actorOf(app, ctx);
  const title = patch.title !== undefined ? cleanTitle(patch.title, page.title) : page.title;
  const body = patch.body !== undefined ? cleanBody(patch.body) : page.body;
  const icon = patch.icon !== undefined ? cleanIcon(patch.icon) : page.icon;
  if (title === page.title && body === page.body && icon === page.icon) return page;
  if (!opts.force && opts.baseVersion !== undefined && Number(opts.baseVersion) !== page.version) {
    throw new HttpError(409, `Die Seite wurde inzwischen von ${page.updated_by_name || 'jemand anderem'} geändert (Version ${page.version}). Bitte neu laden – oder die eigene Fassung mit „Überschreiben“ behalten.`);
  }
  const via = opts.via ?? String(ctx.via ?? '');
  app.db.tx(() => {
    app.db.run('UPDATE wiki_pages SET title = ?, body = ?, text = ?, icon = ?, version = version + 1, updated_at = ?, updated_by = ?, updated_by_name = ? WHERE id = ?', title, body, markdownToText(body), icon, now(), actor.id, actor.name, page.id);
    const rev = page.version + 1;
    const head = app.db.get<any>('SELECT * FROM wiki_versions WHERE page_id = ? ORDER BY rev DESC LIMIT 1', page.id);
    const same = head && !opts.note && !head.note && head.author_id === actor.id && head.author_name === actor.name && head.via === via && Date.now() - Date.parse(head.created_at) < LIMITS.coalesceMs;
    // Autosave: the same person's edits within ten minutes are one version.
    if (same) app.db.run('UPDATE wiki_versions SET rev = ?, title = ?, body = ?, saved_at = ? WHERE id = ?', rev, title, body, now(), head.id);
    else {
      app.db.insert('wiki_versions', { id: id(), page_id: page.id, location_id: page.location_id, rev, title, body, author_id: actor.id, author_name: actor.name, via, note: opts.note ?? '', created_at: now(), saved_at: now() });
      app.db.run(`DELETE FROM wiki_versions WHERE page_id = ? AND id NOT IN (SELECT id FROM wiki_versions WHERE page_id = ? ORDER BY rev DESC LIMIT ${LIMITS.versionsPerPage})`, page.id, page.id);
    }
  });
  const fresh = app.db.get<PageRow>('SELECT * FROM wiki_pages WHERE id = ?', page.id)!;
  indexPage(app, fresh);
  app.db.run('UPDATE wiki_spaces SET updated_at = ? WHERE id = ?', now(), space.id);
  if (body !== page.body) notifyMentions(app, ctx, fresh, space, page.body);
  return fresh;
}

// --- tree operations --------------------------------------------------------------------------------------

export function movePage(app: App, ctx: Ctx, page: PageRow, target: { spaceId?: string; parentId?: string | null; beforeId?: string | null }): PageRow {
  const dest = target.spaceId && target.spaceId !== page.space_id ? loadSpace(app, ctx, target.spaceId, 'edit').space : undefined;
  const spaceId = dest?.id ?? page.space_id;
  const parentId = target.parentId === undefined ? page.parent_id : target.parentId || null;
  if (parentId) {
    const parent = app.db.get<PageRow>('SELECT * FROM wiki_pages WHERE id = ? AND space_id = ? AND trashed_at IS NULL', parentId, spaceId);
    if (!parent) throw bad('Zielseite nicht gefunden');
    if (subtreeIds(app, page.id).includes(parent.id)) throw bad('Eine Seite kann nicht unter sich selbst oder ihren Unterseiten liegen');
    if (depthOf(app, parent.id) + 1 + subtreeDepth(app, page.id) >= LIMITS.depth) throw bad(`Höchstens ${LIMITS.depth} Ebenen`);
  }
  const oldParent = page.parent_id;
  const oldSpace = page.space_id;
  app.db.tx(() => {
    if (spaceId !== oldSpace) app.db.run(`UPDATE wiki_pages SET space_id = ? WHERE id IN (${subtreeIds(app, page.id).map(() => '?').join(',')})`, spaceId, ...subtreeIds(app, page.id));
    app.db.run('UPDATE wiki_pages SET parent_id = ? WHERE id = ?', parentId, page.id);
    const sibs = siblings(app, spaceId, parentId, page.id);
    const at = target.beforeId ? sibs.findIndex((s) => s.id === target.beforeId) : -1;
    sibs.splice(at < 0 ? sibs.length : at, 0, { ...page, id: page.id } as PageRow);
    renumber(app, sibs);
    if (oldParent !== parentId || oldSpace !== spaceId) renumber(app, siblings(app, oldSpace, oldParent));
  });
  return app.db.get<PageRow>('SELECT * FROM wiki_pages WHERE id = ?', page.id)!;
}

export function trashPage(app: App, page: PageRow): string[] {
  const ids = subtreeIds(app, page.id);
  const t = now();
  app.db.tx(() => {
    app.db.run(`UPDATE wiki_pages SET trashed_at = ? WHERE id IN (${ids.map(() => '?').join(',')}) AND trashed_at IS NULL`, t, ...ids);
    renumber(app, siblings(app, page.space_id, page.parent_id));
  });
  unindexIds(app, ids);
  return ids;
}

export function restorePage(app: App, page: PageRow): PageRow {
  const ids = subtreeIds(app, page.id);
  // a parent that is still in the trash: the page comes back at the top of its space
  const parent = page.parent_id ? app.db.get<PageRow>('SELECT * FROM wiki_pages WHERE id = ?', page.parent_id) : undefined;
  const parentId = parent && !parent.trashed_at ? parent.id : null;
  app.db.tx(() => {
    app.db.run(`UPDATE wiki_pages SET trashed_at = NULL WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
    app.db.run('UPDATE wiki_pages SET parent_id = ? WHERE id = ?', parentId, page.id);
    renumber(app, [...siblings(app, page.space_id, parentId, page.id), { id: page.id }]);
  });
  for (const pid of ids) indexPage(app, app.db.get<PageRow>('SELECT * FROM wiki_pages WHERE id = ?', pid)!);
  return app.db.get<PageRow>('SELECT * FROM wiki_pages WHERE id = ?', page.id)!;
}

/** Removes pages for good (versions, comments, links and favourites go with them). */
export function purgeIds(app: App, pageIds: string[]) {
  if (!pageIds.length) return;
  unindexIds(app, pageIds);
  const marks = pageIds.map(() => '?').join(',');
  app.db.run(`DELETE FROM wiki_pages WHERE id IN (${marks})`, ...pageIds);
}

// --- versions ------------------------------------------------------------------------------------------------

export function restoreVersion(app: App, ctx: Ctx, page: PageRow, space: SpaceRow, versionId: string): PageRow {
  const v = app.db.get<any>('SELECT * FROM wiki_versions WHERE id = ? AND page_id = ?', versionId, page.id);
  if (!v) throw notFound('Version nicht gefunden');
  const label = `Wiederhergestellt aus Version vom ${new Date(v.saved_at).toLocaleString('de-DE', { timeZone: app.location(ctx.locationId)?.timezone || 'Europe/Berlin' })}`;
  return updatePage(app, ctx, page, space, { title: v.title, body: v.body }, { force: true, note: label });
}

// --- search ----------------------------------------------------------------------------------------------------

export interface Hit {
  id: string;
  title: string;
  icon: string;
  space_id: string;
  space_name: string;
  parent_id: string | null;
  updated_at: string;
  snippet: string;
}

export function searchPages(app: App, ctx: Ctx, q: string, opts: { spaceId?: string; limit?: number; titlesOnly?: boolean } = {}): Hit[] {
  const spaces = accessibleSpaces(app, ctx).filter((s) => !opts.spaceId || s.space.id === opts.spaceId);
  if (!spaces.length) return [];
  const names = new Map(spaces.map((s) => [s.space.id, s.space.name]));
  const ids = [...names.keys()];
  const marks = ids.map(() => '?').join(',');
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const words = searchWords(q);
  const base = (r: any, snippet: string): Hit => ({ id: r.id, title: r.title, icon: r.icon, space_id: r.space_id, space_name: names.get(r.space_id) ?? '', parent_id: r.parent_id, updated_at: r.updated_at, snippet });
  if (!words.length) {
    return app.db.all<any>(`SELECT id, title, icon, space_id, parent_id, updated_at, text FROM wiki_pages WHERE location_id = ? AND trashed_at IS NULL AND space_id IN (${marks}) ORDER BY updated_at DESC LIMIT ?`, ctx.locationId, ...ids, limit).map((r) => base(r, plainSnippet(r.text, [], 120)));
  }
  const f = fts(app);
  if (f.ok && !opts.titlesOnly) {
    const expr = matchExpr(q)!;
    try {
      return app.db
        .all<any>(
          `SELECT p.id, p.title, p.icon, p.space_id, p.parent_id, p.updated_at, snippet(${f.table}, 1, '${HIT_START}', '${HIT_END}', '…', 18) AS snip
           FROM ${f.table} JOIN wiki_pages p ON p.rowid = ${f.table}.rowid
           WHERE ${f.table} MATCH ? AND p.location_id = ? AND p.trashed_at IS NULL AND p.space_id IN (${marks})
           ORDER BY bm25(${f.table}, 6.0, 1.0) LIMIT ?`,
          expr,
          ctx.locationId,
          ...ids,
          limit,
        )
        .map((r) => base(r, r.snip && r.snip.includes(HIT_START) ? r.snip : plainSnippet(r.snip || '', words, 120)));
    } catch (e) {
      console.error('[wiki] fts', (e as Error).message);
    }
  }
  const cols = opts.titlesOnly ? ['p.title'] : ['p.title', 'p.text'];
  const where = words.map(() => `(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`).join(' AND ');
  const params = words.flatMap((w) => cols.map(() => likePattern(w)));
  return app.db
    .all<any>(`SELECT p.id, p.title, p.icon, p.space_id, p.parent_id, p.updated_at, p.text FROM wiki_pages p WHERE p.location_id = ? AND p.trashed_at IS NULL AND p.space_id IN (${marks}) AND ${where} ORDER BY (p.title LIKE ? ESCAPE '\\') DESC, p.updated_at DESC LIMIT ?`, ctx.locationId, ...ids, ...params, likePattern(words[0]), limit)
    .map((r) => base(r, plainSnippet(r.text, words, 120)));
}

/** Rebuilds the search index from the pages (after an import into a database that had none). */
export function reindexAll(app: App) {
  const f = fts(app);
  if (!f.ok) return;
  f.backfill(() => app.db.all<{ r: number; title: string; text: string }>('SELECT rowid AS r, title, text FROM wiki_pages WHERE trashed_at IS NULL').map((p) => ({ rowid: p.r, values: { title: p.title, body: p.text } })));
}

export { track };
export type { Actor };
