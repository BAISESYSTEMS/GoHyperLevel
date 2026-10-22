import type { Module } from '../core/app.js';
import { parseRows } from '../core/db.js';
import { bad, clampLimit, HttpError, notFound, num, str, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { contactName, findContacts } from '../services/contacts.js';
import { cleanColumns, cleanDir, cleanFilter, cleanSort, contactOrder, DEFAULT_COLUMNS, smartListById, smartListScope, SORT_KEYS, type SmartListRow } from '../services/smart-lists.js';
import type { Tool } from './mcp.js';

/**
 * Smart Lists 2.0 for contacts (docs/sales.md#smart-lists): a saved view = name + filter + visible columns + sort, per sub-account,
 * shared with the team or private to the person who made it. The table `smart_lists` (modules/contacts.ts) stays the one store –
 * campaigns, the power dialer, sequences, surveys and ad audiences already point at its ids and read its `filter`; this module
 * adds the view columns, the routes, sorting by any column (`app.services.contactOrder`, used by findContacts) and two read
 * tools for agents. Behaviour segments (modules/mk-segments.ts) are a different thing – audiences by what people did – and stay.
 */

type ListRow = SmartListRow;

const MAX_LISTS = 200;

const TOOLS: Tool[] = [
  {
    name: 'ghl_smart_lists',
    title: 'Smart Lists',
    description:
      'Gespeicherte Kontakt-Ansichten (Smart Lists) eines Projekts: Name, Filter, sichtbare Spalten, Sortierung und ob die Liste fürs Team geteilt oder privat ist. ' +
      'Private Listen sieht nur, wer sie angelegt hat (mit einem API-Schlüssel nur die geteilten). Die Kontakte einer Liste liefert ghl_smart_list_contacts.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      const list: any[] = await call.api('GET', '/api/smart-lists', { location: a.location_id });
      return list.map((l) => ({ id: l.id, name: l.name, visibility: l.visibility, mine: l.mine, filter: l.filter, columns: l.columns, sort: l.sort, sort_dir: l.sort_dir }));
    },
  },
  {
    name: 'ghl_smart_list_contacts',
    title: 'Kontakte einer Smart List',
    description: `Die Kontakte einer Smart List (list_id aus ghl_smart_lists) mit Filter und Sortierung der Liste, seitenweise (limit bis 200, offset). Mit sort/dir lässt sich anders sortieren: ${SORT_KEYS.join(', ')} oder custom.<feld>. Es gelten die Datensatz-Rechte der Person.`,
    inputSchema: {
      type: 'object',
      properties: { location_id: { type: 'string' }, list_id: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' }, sort: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } },
      required: ['list_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    untrusted: true,
    run: async (call, a) => {
      const qs = new URLSearchParams();
      if (a.limit !== undefined) qs.set('limit', String(a.limit));
      if (a.offset !== undefined) qs.set('offset', String(a.offset));
      if (a.sort) qs.set('sort', String(a.sort));
      if (a.dir) qs.set('dir', String(a.dir));
      return call.api('GET', `/api/smart-lists/${encodeURIComponent(String(a.list_id ?? ''))}/contacts?${qs}`, { location: a.location_id });
    },
  },
];

export const smartListsModule: Module = {
  name: 'smart-lists',
  migrations: [
    [
      '001-views',
      `
      ALTER TABLE smart_lists ADD COLUMN columns TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE smart_lists ADD COLUMN sort TEXT NOT NULL DEFAULT '';
      ALTER TABLE smart_lists ADD COLUMN sort_dir TEXT NOT NULL DEFAULT '';
      ALTER TABLE smart_lists ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared';
      ALTER TABLE smart_lists ADD COLUMN owner_id TEXT;
      ALTER TABLE smart_lists ADD COLUMN updated_at TEXT;
      CREATE INDEX smart_lists_loc ON smart_lists(location_id, name);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    app.services.contactOrder = (locationId: string, key: string, dir: string) => contactOrder(app, locationId, key, dir);

    /** The person asking ('' for keys and automations – they see the shared lists only). */
    const me = (ctx: Ctx) => ctx.user?.id ?? '';
    const isAdmin = (ctx: Ctx) => !ctx.user || ctx.user.role === 'admin';
    /** Shared lists and the person's own private ones; another person's private list does not exist for anybody else. */
    const visible = (ctx: Ctx) => smartListScope(ctx.locationId, ctx);
    /** Changing a list: the person who made it; admins and keys only shared ones (lists from before 2.0 have no owner). */
    const canEdit = (ctx: Ctx, l: ListRow) => (!!l.owner_id && l.owner_id === me(ctx)) || (l.visibility === 'shared' && (isAdmin(ctx) || !l.owner_id));
    const owners = (rows: ListRow[]) => {
      const ids = [...new Set(rows.map((r) => r.owner_id).filter(Boolean))] as string[];
      if (!ids.length) return new Map<string, string>();
      return new Map(db.all<{ id: string; name: string }>(`SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids).map((u) => [u.id, u.name]));
    };
    const out = (ctx: Ctx, l: ListRow, names = owners([l])) => ({
      ...l,
      columns: l.columns?.length ? l.columns : DEFAULT_COLUMNS,
      owner_name: l.owner_id ? (names.get(l.owner_id) ?? '') : '',
      mine: !!l.owner_id && l.owner_id === me(ctx),
      can_edit: canEdit(ctx, l),
    });
    const load = (ctx: Ctx, listId: string): ListRow => {
      const l = smartListById(app, ctx.locationId, listId, ctx);
      if (!l) throw notFound('Smart List nicht gefunden');
      return l;
    };
    const visibilityOf = (ctx: Ctx, v: unknown): 'shared' | 'private' => {
      if (v !== 'private') return 'shared';
      if (!ctx.user) throw bad('Private Smart Lists gibt es nur mit Anmeldung – mit einem API-Schlüssel ist jede Liste geteilt');
      return 'private';
    };

    router.get('/api/smart-lists', 'location', (ctx) => {
      const v = visible(ctx);
      const rows = parseRows(db.all<ListRow>(`SELECT * FROM smart_lists WHERE ${v.sql} ORDER BY lower(name)`, ...v.params), ['filter', 'columns']) as ListRow[];
      const names = owners(rows);
      return rows.map((l) => out(ctx, l, names));
    });

    router.post('/api/smart-lists', 'location', (ctx) => {
      const b = ctx.body ?? {};
      if ((db.get<{ n: number }>('SELECT COUNT(*) AS n FROM smart_lists WHERE location_id = ?', ctx.locationId)?.n ?? 0) >= MAX_LISTS) throw bad(`Höchstens ${MAX_LISTS} Smart Lists je Sub-Account`);
      const row = {
        id: id(),
        location_id: ctx.locationId,
        name: str(b.name, 'Name', { required: true, max: 100 }),
        filter: cleanFilter(b.filter),
        columns: cleanColumns(app, ctx.locationId, b.columns),
        sort: cleanSort(app, ctx.locationId, b.sort),
        sort_dir: cleanDir(b.sort_dir),
        visibility: visibilityOf(ctx, b.visibility),
        owner_id: ctx.user?.id ?? null,
        created_at: now(),
        updated_at: now(),
      };
      db.insert('smart_lists', row);
      return out(ctx, load(ctx, row.id));
    });

    router.get('/api/smart-lists/:id', 'location', (ctx) => out(ctx, load(ctx, ctx.params.id)));

    router.patch('/api/smart-lists/:id', 'location', (ctx) => {
      const l = load(ctx, ctx.params.id);
      if (!canEdit(ctx, l)) throw new HttpError(403, 'Diese Smart List kann nur ändern, wer sie angelegt hat (oder ein Admin, wenn sie geteilt ist)');
      const b = ctx.body ?? {};
      const patch: Record<string, unknown> = { updated_at: now() };
      if (b.name !== undefined) patch.name = str(b.name, 'Name', { required: true, max: 100 });
      if (b.filter !== undefined) patch.filter = cleanFilter(b.filter);
      if (b.columns !== undefined) patch.columns = cleanColumns(app, ctx.locationId, b.columns);
      if (b.sort !== undefined) patch.sort = cleanSort(app, ctx.locationId, b.sort);
      if (b.sort_dir !== undefined) patch.sort_dir = cleanDir(b.sort_dir);
      if (b.visibility !== undefined) {
        const next = visibilityOf(ctx, b.visibility);
        if (next !== l.visibility && l.owner_id !== me(ctx)) throw new HttpError(403, 'Nur wer die Liste angelegt hat, kann sie teilen oder privat machen');
        patch.visibility = next;
      }
      db.update('smart_lists', l.id, patch, ctx.locationId);
      return out(ctx, load(ctx, l.id));
    });

    router.delete('/api/smart-lists/:id', 'location', (ctx) => {
      const l = smartListById(app, ctx.locationId, ctx.params.id, ctx);
      if (!l) return { ok: true };
      if (!canEdit(ctx, l)) throw new HttpError(403, 'Diese Smart List kann nur löschen, wer sie angelegt hat (oder ein Admin, wenn sie geteilt ist)');
      db.run('DELETE FROM smart_lists WHERE id = ? AND location_id = ?', l.id, ctx.locationId);
      return { ok: true };
    });

    /** The list's contacts with its filter and sort (or `?sort=&dir=` for another order) – narrowed by the record-access rules. */
    router.get('/api/smart-lists/:id/contacts', 'location', (ctx) => {
      const l = load(ctx, ctx.params.id);
      const f = l.filter ?? {};
      const asked = ctx.query.get('sort');
      const sort = asked ? cleanSort(app, ctx.locationId, asked) : l.sort;
      const dir = asked ? cleanDir(ctx.query.get('dir')) : (cleanDir(ctx.query.get('dir')) || cleanDir(l.sort_dir));
      const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
      const { total, contacts } = findContacts(app, ctx.locationId, {
        tags: list(f.tags),
        anyTags: list(f.anyTags),
        excludeTags: list(f.excludeTags),
        q: String(f.q ?? ''),
        extra: f,
        sort,
        dir,
        limit: clampLimit(ctx.query.get('limit'), 50, 200),
        offset: Math.max(0, num(ctx.query.get('offset'), 0)),
        who: ctx,
      });
      const columns = l.columns?.length ? l.columns : DEFAULT_COLUMNS;
      const customKeys = columns.filter((c) => c.startsWith('custom.')).map((c) => c.slice(7));
      return {
        list: { id: l.id, name: l.name, visibility: l.visibility, columns, sort, sort_dir: dir },
        total,
        contacts: contacts.map((c) => ({
          id: c.id,
          name: contactName(c),
          email: c.email,
          phone: c.phone,
          company: c.company,
          city: c.city,
          source: c.source,
          tags: c.tags,
          assigned_to: c.assigned_to,
          created_at: c.created_at,
          last_activity_at: c.last_activity_at ?? null,
          custom: Object.fromEntries(customKeys.map((k) => [k, c.custom?.[k] ?? null])),
        })),
      };
    });
  },
};
