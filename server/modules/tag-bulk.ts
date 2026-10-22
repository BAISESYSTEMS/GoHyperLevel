import { smartListScope, type ListReader } from '../services/smart-lists.js';
import type { Module } from '../core/app.js';
import { HttpError, bad, str, type Ctx } from '../core/http.js';
import { cleanColor } from '../services/tag-meta.js';
import type { Tool } from './mcp.js';

/**
 * Tag management in bulk (docs/api.md#tags-in-bulk): how often each tag is used (contacts, workflows, smart lists) and one route
 * for the bulk edits of *Einstellungen → Tags* – rename, merge several into one, delete several, colour or category for several.
 * Renaming and merging rewrite the names on the contacts in SQL (`contacts.tags` is a JSON list of names) without firing
 * "tag added/removed" workflows – nothing happened to the people, only the label changed. Every action is one undo entry
 * (entity `tag` of the undo journal, which remembers the contacts that carried the tag).
 */

type TagRow = { id: string; name: string; color: string; category_id: string | null };

const asHttp = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw bad((e as Error).message);
  }
};

const ACTIONS = ['rename', 'merge', 'delete', 'color', 'category'] as const;
type Action = (typeof ACTIONS)[number];

/** The ids of the request body (deduplicated, at most 500). */
const bodyIds = (body: any): string[] => (Array.isArray(body?.ids) ? [...new Set<string>(body.ids.map(String))].filter(Boolean).slice(0, 500) : []);

/** `contacts.tags` with every name of `from` replaced by `to`, duplicates dropped, order kept (SQL fragment + params). */
const renameSql = (from: string[]) =>
  `UPDATE contacts SET tags = (
     SELECT json_group_array(v) FROM (SELECT CASE WHEN value IN (${from.map(() => '?').join(',')}) THEN ? ELSE value END AS v, MIN(key) AS k FROM json_each(contacts.tags) GROUP BY v ORDER BY k)
   ) WHERE location_id = ? AND EXISTS (SELECT 1 FROM json_each(contacts.tags) WHERE value IN (${from.map(() => '?').join(',')}))`;

const TOOLS: Tool[] = [
  {
    name: 'ghl_tags_usage',
    title: 'Tags mit Nutzung auflisten',
    description: 'Alle Tags des Sub-Accounts mit Farbe, Kategorie und Nutzung: Anzahl Kontakte, Workflows und Smart Lists, die den Tag nennen. Ungenutzte Tags haben überall 0.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, unused_only: { type: 'boolean' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      const r = await call.api('GET', '/api/tags/usage', { location: a.location_id });
      return a.unused_only ? { tags: r.tags.filter((t: any) => t.unused) } : r;
    },
  },
  {
    name: 'ghl_tags_bulk',
    title: 'Tags umbenennen, zusammenführen, löschen, färben',
    description:
      'Massenpflege von Tags (IDs aus ghl_tags_usage). action: rename (ids=[eine ID], name), merge (ids = Quellen, into = Ziel-Tag-ID; die Quellen verschwinden, ihre Kontakte bekommen das Ziel), delete (ids; der Tag verschwindet von allen Kontakten), color (ids, color #rrggbb oder leer), category (ids, category_id oder leer). Löst keine Tag-Workflows aus; jede Aktion ist ein Eintrag im Verlauf (rückgängig machbar).',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string' },
        action: { type: 'string', enum: [...ACTIONS] },
        ids: { type: 'array', items: { type: 'string' } },
        name: { type: 'string' },
        into: { type: 'string' },
        color: { type: 'string' },
        category_id: { type: 'string' },
      },
      required: ['action', 'ids'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    klassFor: (a) => (a.action === 'delete' || a.action === 'merge' ? 'sensitive' : 'write'),
    run: (call, a) => call.api('POST', '/api/tags/bulk', { location: a.location_id, body: { action: a.action, ids: a.ids, name: a.name, into: a.into, color: a.color, category_id: a.category_id } }),
  },
];

export const tagBulkModule: Module = {
  name: 'tag-bulk',
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    const tagsOf = (locationId: string, ids: string[]): TagRow[] =>
      ids.length ? db.all<TagRow>(`SELECT id, name, color, category_id FROM tags WHERE location_id = ? AND id IN (${ids.map(() => '?').join(',')})`, locationId, ...ids) : [];

    /** Workflows whose trigger or steps mention a tag name (as a JSON string), by name – for the "used in" hint. */
    const workflowRefs = (locationId: string): { id: string; name: string; text: string }[] =>
      db.all<{ id: string; name: string; text: string }>(`SELECT id, name, trigger || ' ' || steps AS text FROM workflows WHERE location_id = ?`, locationId);
    // Only the lists the person may load: another person's private list is not named (services/smart-lists.ts).
    const listRefs = (locationId: string, who: ListReader): { id: string; name: string; text: string }[] => {
      const s = smartListScope(locationId, who);
      return db.all<{ id: string; name: string; text: string }>(`SELECT id, name, filter AS text FROM smart_lists WHERE ${s.sql}`, ...s.params);
    };
    const mentions = (text: string, name: string) => text.includes(JSON.stringify(name));

    router.get('/api/tags/usage', 'location', (ctx) => {
      const tags = db.all<TagRow & { contacts: number }>(
        `SELECT t.id, t.name, t.color, t.category_id, COALESCE(n.c, 0) AS contacts
         FROM tags t LEFT JOIN (SELECT j.value AS name, COUNT(*) AS c FROM contacts c, json_each(c.tags) j WHERE c.location_id = ? GROUP BY j.value) n ON n.name = t.name
         WHERE t.location_id = ? ORDER BY t.name`,
        ctx.locationId,
        ctx.locationId,
      );
      const wfs = workflowRefs(ctx.locationId);
      const lists = listRefs(ctx.locationId, ctx);
      return {
        tags: tags.map((t) => {
          const workflows = wfs.filter((w) => mentions(w.text, t.name)).map((w) => ({ id: w.id, name: w.name }));
          const smartLists = lists.filter((l) => mentions(l.text, t.name)).map((l) => ({ id: l.id, name: l.name }));
          return { ...t, workflows, smart_lists: smartLists, unused: t.contacts === 0 && !workflows.length && !smartLists.length };
        }),
      };
    });

    router.post('/api/tags/bulk', 'location', (ctx) => {
      const action = String(ctx.body?.action ?? '') as Action;
      if (!ACTIONS.includes(action)) throw bad(`Unbekannte Aktion (${ACTIONS.join(', ')})`);
      const ids = bodyIds(ctx.body);
      if (!ids.length) throw bad('ids: die gewählten Tags angeben');
      const tags = tagsOf(ctx.locationId, ids);
      if (tags.length !== ids.length) throw bad('Unbekannter Tag');
      const loc = ctx.locationId;

      if (action === 'rename') {
        if (tags.length !== 1) throw bad('Umbenennen geht für genau einen Tag');
        const name = str(ctx.body.name, 'Name', { required: true, max: 80 });
        const old = tags[0];
        if (name === old.name) return { count: 0, tags: tagsOf(loc, ids) };
        if (db.get('SELECT 1 AS x FROM tags WHERE location_id = ? AND name = ?', loc, name)) throw bad(`„${name}“ gibt es schon – zum Zusammenlegen „Zusammenführen“ nehmen`);
        let contacts = 0;
        db.tx(() => {
          contacts = db.run(renameSql([old.name]), old.name, name, loc, old.name).changes;
          db.run('UPDATE tags SET name = ? WHERE id = ?', name, old.id);
        });
        return { count: 1, contacts, references: refsOf(loc, [old.name], ctx) };
      }

      if (action === 'merge') {
        const into = tagsOf(loc, [String(ctx.body.into ?? '')])[0];
        if (!into) throw bad('into: den Ziel-Tag angeben');
        const sources = tags.filter((t) => t.id !== into.id);
        if (!sources.length) throw bad('Mindestens einen anderen Tag zum Zusammenführen wählen');
        const names = sources.map((t) => t.name);
        let contacts = 0;
        db.tx(() => {
          contacts = db.run(renameSql(names), ...names, into.name, loc, ...names).changes;
          db.run(`DELETE FROM tags WHERE location_id = ? AND id IN (${sources.map(() => '?').join(',')})`, loc, ...sources.map((t) => t.id));
        });
        return { count: sources.length, contacts, into: into.id, references: refsOf(loc, names, ctx) };
      }

      if (action === 'delete') {
        let contacts = 0;
        db.tx(() => {
          for (const t of tags) {
            contacts += db.run(
              `UPDATE contacts SET tags = (SELECT json_group_array(value) FROM json_each(contacts.tags) WHERE value != ?)
               WHERE location_id = ? AND EXISTS (SELECT 1 FROM json_each(contacts.tags) WHERE value = ?)`,
              t.name,
              loc,
              t.name,
            ).changes;
            db.run('DELETE FROM tags WHERE id = ?', t.id);
          }
        });
        return { count: tags.length, contacts, references: refsOf(loc, tags.map((t) => t.name), ctx) };
      }

      if (action === 'color') {
        const color = asHttp(() => cleanColor(ctx.body.color));
        db.tx(() => {
          for (const t of tags) db.run('UPDATE tags SET color = ? WHERE id = ?', color, t.id);
        });
        return { count: tags.length, tags: tagsOf(loc, ids) };
      }

      // category
      const cid = ctx.body.category_id ? String(ctx.body.category_id) : null;
      if (cid && !db.get('SELECT 1 AS x FROM tag_categories WHERE id = ? AND location_id = ?', cid, loc)) throw bad('Kategorie nicht gefunden');
      db.tx(() => {
        for (const t of tags) db.run('UPDATE tags SET category_id = ? WHERE id = ?', cid, t.id);
      });
      return { count: tags.length, tags: tagsOf(loc, ids) };
    });

    /** Workflows and smart lists that still name one of these tags (they keep the old name – the answer says where to look). */
    function refsOf(locationId: string, names: string[], who: ListReader) {
      return {
        workflows: workflowRefs(locationId).filter((w) => names.some((n) => mentions(w.text, n))).map((w) => ({ id: w.id, name: w.name })),
        smart_lists: listRefs(locationId, who).filter((l) => names.some((n) => mentions(l.text, n))).map((l) => ({ id: l.id, name: l.name })),
      };
    }

    // --- undo: one entry per request; the `tag` entity (services/undo-entities.ts) remembers the contacts carrying each tag ----------
    const undo = app.services.undo as { track(rule: unknown): void } | undefined;
    if (undo) {
      const LABEL: Record<string, string> = { rename: 'umbenannt', merge: 'zusammengeführt', delete: 'gelöscht', color: 'neu gefärbt', category: 'neu einsortiert' };
      undo.track({
        method: 'POST',
        pattern: '/api/tags/bulk',
        entity: 'tag',
        targets: (ctx: Ctx) => [...bodyIds(ctx.body), ...(ctx.body?.action === 'merge' && ctx.body?.into ? [String(ctx.body.into)] : [])].filter((v, i, a) => a.indexOf(v) === i).map((id) => ({ id })),
        action: (_b: unknown, a: unknown) => (!a ? 'delete' : 'bulk'),
        groupLabel: (ctx: Ctx) => {
          const n = bodyIds(ctx.body).length;
          return `${n} ${n === 1 ? 'Tag' : 'Tags'} ${LABEL[String(ctx.body?.action)] ?? 'geändert'}`;
        },
      });
    }
  },
};
