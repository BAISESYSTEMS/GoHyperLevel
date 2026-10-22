import type { Module } from '../core/app.js';
import { HIT_END, HIT_START } from '../services/collab-fts.js';
import type { Tool } from './mcp.js';

/**
 * MCP tools for the Wiki – agents (Claude, ChatGPT, the in-app HyperLevel Agent) search, read and write pages.
 * Like every MCP tool they relay onto the REST API (/api/wiki/…), so the key's sub-account, member rights, the
 * space's team access, version history and the audit log apply; an agent's edits show up in the page history
 * with the key's name.
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const RO = { readOnlyHint: true, openWorldHint: false };
const link = (id: string) => `/app/wiki/${id}`;
const plain = (s: string) => String(s ?? '').split(HIT_START).join('**').split(HIT_END).join('**');

const TOOLS: Tool[] = [
  {
    name: 'ghl_wiki_search',
    title: 'Wiki durchsuchen',
    description: 'Volltextsuche im Team-Wiki eines Sub-Accounts (Titel und Text; alle Wörter müssen vorkommen, Wortanfänge genügen). Gibt Seiten mit Auszug zurück – danach ghl_wiki_get für den ganzen Text. Ohne query: die zuletzt geänderten Seiten.',
    inputSchema: obj({ ...LOC, query: { type: 'string' }, space: { type: 'string', description: 'Bereichs-ID, um auf einen Bereich zu beschränken' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['location_id']),
    annotations: RO,
    run: async (call, a) => {
      const q = new URLSearchParams({ q: String(a.query ?? ''), limit: String(a.limit ?? 10), ...(a.space ? { space_id: String(a.space) } : {}) });
      const r: any[] = await call.api('GET', `/api/wiki/search?${q}`, { location: a.location_id });
      return { results: r.map((h) => ({ id: h.id, title: h.title, space: h.space_name, snippet: plain(h.snippet), updated_at: h.updated_at, link: link(h.id) })) };
    },
  },
  {
    name: 'ghl_wiki_get',
    title: 'Wiki-Seite lesen',
    description: 'Liest eine Wiki-Seite als Markdown (Überschriften, Listen, Checklisten „- [ ] …“, Tabellen, Hinweise „> [!INFO]“, @Erwähnungen „[@Name](user:ID)“, Karten „[Label](card:contact:ID)“) – per page_id oder per genauem Titel (title, optional space). Enthält Version (für base_version beim Schreiben), Pfad, Unterseiten und offene Kommentare.',
    inputSchema: obj({ ...LOC, page_id: { type: 'string' }, title: { type: 'string', description: 'Genauer Seitentitel (statt page_id)' }, space: { type: 'string', description: 'Bereichs-ID, wenn der Titel in mehreren Bereichen vorkommt' } }, ['location_id']),
    annotations: RO,
    run: async (call, a) => {
      let pid = a.page_id ? String(a.page_id) : '';
      if (!pid) {
        if (!a.title) throw new Error('page_id oder title angeben');
        const hits: any[] = await call.api('GET', `/api/wiki/search?${new URLSearchParams({ q: String(a.title), titles: '1', limit: '20', ...(a.space ? { space_id: String(a.space) } : {}) })}`, { location: a.location_id });
        const exact = hits.filter((h) => h.title.toLowerCase() === String(a.title).toLowerCase());
        const pick = exact[0] ?? hits[0];
        if (!pick) throw new Error(`Keine Seite „${a.title}“ gefunden`);
        pid = pick.id;
      }
      const p = await call.api('GET', `/api/wiki/pages/${encodeURIComponent(pid)}`, { location: a.location_id });
      return {
        id: p.id,
        title: p.title,
        space: p.space_name,
        path: [...p.path.map((x: any) => x.title), p.title],
        markdown: p.body,
        version: p.version,
        updated_at: p.updated_at,
        updated_by: p.updated_by_name,
        tasks: p.tasks,
        open_comments: p.comments?.open ?? 0,
        children: p.children,
        link: link(p.id),
      };
    },
  },
  {
    name: 'ghl_wiki_upsert_page',
    title: 'Wiki-Seite anlegen oder ändern',
    description:
      'Legt eine Wiki-Seite an oder ändert sie. Mit page_id wird diese Seite geändert; sonst wird im Bereich (space = ID oder Name, Standard: der erste beschreibbare; fehlt er, wird er angelegt) unter parent_id nach einer Seite mit genau diesem Titel gesucht – gefunden = ändern, sonst neu anlegen. body ist Markdown; mode "append" hängt an die Seite an, Standard ersetzt den Text. Ein Seitenverlauf bleibt erhalten (jede Fassung ist wiederherstellbar). base_version (aus ghl_wiki_get) lehnt die Änderung ab, wenn jemand die Seite inzwischen geändert hat.',
    inputSchema: obj(
      {
        ...LOC,
        page_id: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string', description: 'Markdown' },
        space: { type: 'string', description: 'Bereichs-ID oder -Name' },
        parent_id: { type: 'string', description: 'Übergeordnete Seite (nur beim Anlegen)' },
        mode: { type: 'string', enum: ['replace', 'append'] },
        base_version: { type: 'integer' },
        icon: { type: 'string', description: 'Ein Emoji' },
        note: { type: 'string', description: 'Vermerk für den Seitenverlauf' },
      },
      ['location_id'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async (call, a) => {
      const { location_id, ...body } = a;
      const p = await call.api('POST', '/api/wiki/upsert', { location: location_id, body });
      return { created: p.created, id: p.id, title: p.title, space: p.space_name, version: p.version, link: link(p.id) };
    },
  },
];

export const wikiMcpModule: Module = {
  name: 'wiki-mcp',
  register(app) {
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};
