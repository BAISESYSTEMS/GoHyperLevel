import type { Module } from '../core/app.js';
import type { Tool } from './mcp.js';

/**
 * MCP tools for the Canvas – agents (Claude, ChatGPT, the in-app HyperLevel Agent) read and draw on
 * boards. Like every MCP tool they relay onto the REST API (/api/canvas/…), so the key's sub-account,
 * member rights, board sharing and the audit log apply; edits appear live for people watching the board,
 * with an agent cursor named after the key/agent.
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const BOARD = { board_id: { type: 'string', description: 'Board-ID (aus ghl_canvas_list)' } };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
/** Page of a board in the app (the in-app agent shows it as an "Öffnen" link; `focus` zooms to elements). */
const boardLink = (id: string, focus: string[] = []) => `/app/canvas/${id}${focus.length ? `?focus=${focus.slice(0, 12).map(encodeURIComponent).join('%2C')}` : ''}`;
const RO = { readOnlyHint: true, openWorldHint: false };
const W = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const ELEMENTS_DOC = `Elemente (JSON, Koordinaten in px, x/y = links oben, y wächst nach unten):
- Formen: {type:"rect"|"ellipse"|"diamond", x, y, w, h, text?, fill?, stroke?, strokeWidth?, radius?, fontSize?, bold?, color?, sketch?:true (handgezeichnet)}
- Notiz: {type:"sticky", text, fill? (#fff3a3 gelb, #ffc9de rosa, #c5e4ff blau, #c3f0c8 grün, #e5dbff lila, #ffd8a8 orange)}
- Text: {type:"text", text, fontSize?, bold?, align?:"left"|"center"|"right", w? (Umbruchbreite)}
- Pfeil/Linie: {type:"arrow"|"line", from: ref|id, to: ref|id, text? (Beschriftung), route?:"straight"|"elbow"|"curved", endHead?:"arrow"|"triangle"|"none", strokeStyle?:"dashed"} – bleibt an den Formen haften
- Rahmen/Artboard: {type:"frame", name, preset?:"desktop"|"mobile"|"tablet"|"social-square"|"social-portrait"|"social-landscape"|"story"|"a4"|"slide", w, h} – Inhalte mit in: ref|id
- Icon: {type:"icon", icon:"rocket"|"user"|"mail"|"phone"|"calendar-days"|"star"|"target"|"zap"|"lightbulb"|"euro"|"chart-column"|… , w, h, stroke?}
- Tabelle: {type:"table", cells:[["Kopf1","Kopf2"],["a","b"]], header?:true, w, h}
- Diagramm: {type:"chart", chart:{kind:"bar"|"line"|"area"|"pie"|"donut", title?, labels:[…], series:[{name, values:[…]}]}, w?, h?}
- Live-CRM-Karte: {type:"card", card:{kind:"contact"|"company"|"deal"|"task"|"ticket"|"appointment"|"project"|"report"|"pipeline", id}} (pipeline = ganzes Board mit Stufen)
- Bild: {type:"image", src:"/uploads/…" (aus der Mediathek), w, h}
Platzierung ohne Koordinaten: ref:"a" vergibt einen Namen; at:{right_of|left_of|below|above: ref|id, gap?} legt neben ein Element; in: ref|id setzt in einen Rahmen; ganz ohne Angabe ordnen sich neue Elemente rechts neben dem Inhalt an (oder per layout).`;

const TOOLS: Tool[] = [
  {
    name: 'ghl_canvas_list',
    title: 'Canvas-Boards auflisten',
    description: 'Alle Canvas-Boards (Whiteboards/Designs) eines Sub-Accounts, auf die diese Verbindung Zugriff hat – mit Anzahl Elemente, letzter Änderung und wer gerade zuschaut.',
    inputSchema: obj({ ...LOC }, ['location_id']),
    annotations: RO,
    run: async (call, a) => {
      const r = await call.api('GET', '/api/canvas', { location: a.location_id });
      return { boards: (r.boards ?? []).map((b: any) => ({ id: b.id, name: b.name, element_count: b.element_count, updated_at: b.updated_at, updated_by: b.updated_by, access: b.access, watching: b.watching, url: `/app/canvas/${b.id}` })) };
    },
  },
  {
    name: 'ghl_canvas_create',
    title: 'Canvas-Board anlegen',
    description: `Legt ein neues Board an – leer, aus einer Vorlage (template: mindmap, flowchart, journey, funnel, sales, org, swot, kanban, wireframe, social), aus Mermaid-Text oder direkt mit Elementen. team_access: edit (Standard), view oder none (privat). ${ELEMENTS_DOC}`,
    inputSchema: obj(
      {
        ...LOC,
        name: { type: 'string' },
        template: { type: 'string', enum: ['mindmap', 'flowchart', 'journey', 'funnel', 'sales', 'org', 'swot', 'kanban', 'wireframe', 'social'] },
        mermaid: { type: 'string', description: 'flowchart/graph, mindmap oder sequenceDiagram' },
        elements: { type: 'array', items: { type: 'object' } },
        team_access: { type: 'string', enum: ['edit', 'view', 'none'] },
      },
      ['location_id', 'name'],
    ),
    annotations: W,
    run: async (call, a) => {
      const { location_id, ...body } = a;
      const b = await call.api('POST', '/api/canvas', { location: location_id, body });
      return { board_id: b.id, name: b.name, element_count: b.element_count, url: b.url, link: boardLink(b.id) };
    },
  },
  {
    name: 'ghl_canvas_get',
    title: 'Canvas-Board lesen',
    description: 'Liest ein Board: strukturiertes JSON aller Elemente (id, type, Position, Text, Verbindungen, version), optional eine Text-Gliederung (Rahmen, Inhalte, Pfeile von → nach) und ein SVG-Bild. include: ["json","outline","svg"] (Standard json+outline).',
    inputSchema: obj({ ...LOC, ...BOARD, include: { type: 'array', items: { type: 'string', enum: ['json', 'outline', 'svg'] } }, svg_max_size: { type: 'integer', description: 'Längste Kante des SVG in px (Standard 1600)' } }, ['location_id', 'board_id']),
    annotations: RO,
    run: async (call, a) => {
      const inc: string[] = Array.isArray(a.include) && a.include.length ? a.include : ['json', 'outline'];
      const q = new URLSearchParams({ ...(inc.includes('outline') ? { outline: '1' } : {}), ...(inc.includes('svg') ? { svg: '1', max: String(a.svg_max_size ?? 1600) } : {}) });
      const r = await call.api('GET', `/api/canvas/${encodeURIComponent(a.board_id)}?${q}`, { location: a.location_id });
      const out: Record<string, unknown> = { link: boardLink(r.board.id), board: { id: r.board.id, name: r.board.name, seq: r.seq, access: r.access, element_count: r.board.element_count, updated_at: r.board.updated_at }, viewers: (r.viewers ?? []).map((v: any) => ({ name: v.name, kind: v.kind })) };
      if (inc.includes('json')) out.elements = (r.elements ?? []).map(({ seed: _s, ...e }: any) => e);
      if (inc.includes('outline')) out.outline = r.outline;
      if (inc.includes('svg')) out.svg = r.svg;
      return out;
    },
  },
  {
    name: 'ghl_canvas_add_elements',
    title: 'Auf dem Canvas zeichnen',
    description: `Fügt mehrere Elemente auf einmal hinzu (bis 1000). Pfeile verbinden Formen über from/to (ref oder id). layout ordnet die neuen Formen automatisch an: {kind:"flow"|"tree"|"mindmap"|"radial"|"grid", direction?:"right"|"down"}. origin {x,y} setzt die linke obere Ecke. Gibt refs → ids zurück. ${ELEMENTS_DOC}`,
    inputSchema: obj(
      {
        ...LOC,
        ...BOARD,
        elements: { type: 'array', items: { type: 'object' }, minItems: 1 },
        layout: { type: 'object', properties: { kind: { type: 'string', enum: ['flow', 'tree', 'mindmap', 'radial', 'grid'] }, direction: { type: 'string', enum: ['right', 'down', 'left', 'up'] }, gap: { type: 'number' } } },
        origin: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
      },
      ['location_id', 'board_id', 'elements'],
    ),
    annotations: W,
    run: async (call, a) => {
      const r = await call.api('POST', `/api/canvas/${encodeURIComponent(a.board_id)}/elements`, { location: a.location_id, body: { elements: a.elements, layout: a.layout, origin: a.origin } });
      return { seq: r.seq, refs: r.refs, created: r.created, errors: r.errors, link: boardLink(a.board_id, r.created ?? []) };
    },
  },
  {
    name: 'ghl_canvas_update_elements',
    title: 'Canvas-Elemente ändern',
    description: 'Ändert Elemente: updates: [{id, …Felder wie beim Anlegen (x, y, w, h, text, fill, stroke, angle, locked, hidden, z …)}]. Nur übergebene Felder ändern sich; null entfernt ein Feld. base_version (aus ghl_canvas_get) meldet Konflikte, strict=true lehnt veraltete Änderungen dann ab statt sie zu überschreiben.',
    inputSchema: obj({ ...LOC, ...BOARD, updates: { type: 'array', items: { type: 'object' }, minItems: 1 }, strict: { type: 'boolean' } }, ['location_id', 'board_id', 'updates']),
    annotations: { ...W, idempotentHint: true },
    run: async (call, a) => {
      const ops = (a.updates as any[]).map(({ id, base_version, ...props }) => ({ op: 'update', id, props, ...(base_version !== undefined ? { baseVersion: base_version } : {}) }));
      const r = await call.api('POST', `/api/canvas/${encodeURIComponent(a.board_id)}/ops`, { location: a.location_id, body: { ops, strict: !!a.strict } });
      return { seq: r.seq, results: r.results, current: r.current };
    },
  },
  {
    name: 'ghl_canvas_delete_elements',
    title: 'Canvas-Elemente löschen',
    description: 'Löscht Elemente (ids). Ein gelöschter Rahmen nimmt seinen Inhalt mit. Rückgängig über die Versionen des Boards.',
    inputSchema: obj({ ...LOC, ...BOARD, ids: { type: 'array', items: { type: 'string' }, minItems: 1 } }, ['location_id', 'board_id', 'ids']),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    run: async (call, a) => {
      const r = await call.api('POST', `/api/canvas/${encodeURIComponent(a.board_id)}/ops`, { location: a.location_id, body: { ops: (a.ids as string[]).map((id) => ({ op: 'delete', id })) } });
      return { seq: r.seq, results: r.results };
    },
  },
  {
    name: 'ghl_canvas_layout',
    title: 'Canvas automatisch anordnen',
    description:
      'Automatisches Layout (eigener Graph-Algorithmus): kind tree (Baum), flow (Fluss, links→rechts oder direction down), mindmap (Thema in der Mitte, Äste links/rechts), radial (Ringe) oder grid (Raster). Entweder vorhandene Elemente neu anordnen (ids; ohne ids alle Formen – Pfeile zwischen ihnen bestimmen die Struktur) oder neu zeichnen aus nodes [{id, label, shape?: rect|round|ellipse|diamond|sticky|pill, group?}] und edges [{from, to, label?}] (+ groups [{id,title}] → Rahmen, x/y = Position).',
    inputSchema: obj(
      {
        ...LOC,
        ...BOARD,
        kind: { type: 'string', enum: ['flow', 'tree', 'mindmap', 'radial', 'grid'] },
        direction: { type: 'string', enum: ['right', 'down', 'left', 'up'] },
        ids: { type: 'array', items: { type: 'string' } },
        nodes: { type: 'array', items: { type: 'object' } },
        edges: { type: 'array', items: { type: 'object' } },
        groups: { type: 'array', items: { type: 'object' } },
        x: { type: 'number' },
        y: { type: 'number' },
        sketch: { type: 'boolean' },
      },
      ['location_id', 'board_id', 'kind'],
    ),
    annotations: W,
    run: async (call, a) => {
      const { location_id, board_id, ...body } = a;
      return call.api('POST', `/api/canvas/${encodeURIComponent(board_id)}/layout`, { location: location_id, body });
    },
  },
  {
    name: 'ghl_canvas_from_mermaid',
    title: 'Mermaid auf den Canvas',
    description: 'Zeichnet Mermaid-Text als bearbeitbare Elemente: flowchart/graph (TD/LR, Formen [] () {} (()) ([]), Pfeile --> -.-> ==> mit |Beschriftung|, subgraph → Rahmen), mindmap (Einrückung) und sequenceDiagram (participant, ->>, -->>, Note, loop/alt). Ohne board_id entsteht ein neues Board (name).',
    inputSchema: obj({ ...LOC, board_id: { type: 'string' }, mermaid: { type: 'string' }, name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, sketch: { type: 'boolean' } }, ['location_id', 'mermaid']),
    annotations: W,
    run: async (call, a) => {
      if (!a.board_id) {
        const b = await call.api('POST', '/api/canvas', { location: a.location_id, body: { name: a.name || 'Diagramm', mermaid: a.mermaid } });
        return { board_id: b.id, name: b.name, element_count: b.element_count, url: b.url, link: boardLink(b.id) };
      }
      const r = await call.api('POST', `/api/canvas/${encodeURIComponent(a.board_id)}/mermaid`, { location: a.location_id, body: { source: a.mermaid, x: a.x, y: a.y, sketch: a.sketch } });
      return { board_id: a.board_id, kind: r.kind, created: r.created, seq: r.seq, link: boardLink(a.board_id, r.created ?? []) };
    },
  },
  {
    name: 'ghl_canvas_export',
    title: 'Canvas exportieren',
    description: 'Exportiert ein Board, einen Rahmen (frame_id) oder Elemente (ids) als PNG, SVG oder PDF in die Mediathek und gibt die URL zurück (z. B. für Social-Posts, E-Mails, Funnel-Seiten). scale 1–4 (PNG), theme light|dark, background "none" für transparent, pages "frames" = PDF mit einer Seite je Rahmen.',
    inputSchema: obj(
      { ...LOC, ...BOARD, format: { type: 'string', enum: ['png', 'svg', 'pdf'] }, frame_id: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } }, scale: { type: 'number' }, theme: { type: 'string', enum: ['light', 'dark'] }, background: { type: 'string' }, pages: { type: 'string', enum: ['single', 'frames'] }, name: { type: 'string' } },
      ['location_id', 'board_id', 'format'],
    ),
    annotations: W,
    run: async (call, a) => {
      const { location_id, board_id, ...body } = a;
      const r = await call.api('POST', `/api/canvas/${encodeURIComponent(board_id)}/export`, { location: location_id, body });
      return { upload_id: r.id, url: r.url, src: r.src, format: r.format, width: r.width, height: r.height, size: r.size };
    },
  },
  {
    name: 'ghl_canvas_comment',
    title: 'Canvas-Kommentar',
    description: 'Schreibt einen Kommentar auf ein Board – an ein Element geheftet (element_id) oder an eine Stelle (x/y); parent_id antwortet auf einen Kommentar. „@Vorname Nachname“ im Text erwähnt Teammitglieder (sie bekommen eine Benachrichtigung).',
    inputSchema: obj({ ...LOC, ...BOARD, body: { type: 'string' }, element_id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, parent_id: { type: 'string' } }, ['location_id', 'board_id', 'body']),
    annotations: W,
    run: async (call, a) => {
      const { location_id, board_id, ...body } = a;
      const r = await call.api('POST', `/api/canvas/${encodeURIComponent(board_id)}/comments`, { location: location_id, body });
      return { comment_id: r.id, element_id: r.element_id, mentions: r.mentions, notified: r.notified };
    },
  },
];

export const canvasMcpModule: Module = {
  name: 'canvas-mcp',
  register(app) {
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};

export const CANVAS_TOOLS = TOOLS;
