import type { Module } from '../core/app.js';
import type { Ctx } from '../core/http.js';
import { checkArea, bodyLocation, scope } from '../services/mobile.js';
import { OP_NAMES } from '../services/boards-patch.js';
import { LIMITS, parseSpec } from '../services/boards-model.js';
import type { BoardRow } from '../services/boards-store.js';
import type { Tool } from './mcp.js';

/**
 * Living Boards for agents and the phone: four MCP tools (list, get, apply a patch, the widget catalogue) plus one to
 * create a board – thin relays onto the REST routes (modules/boards.ts), so the key's sub-account, member rights, the
 * audit log and the versions apply – and the read-only mobile endpoints /api/mobile/boards*. The HyperLevel Agent gets
 * the tools automatically (app.services.mcpTools) and a short hint on how to use them.
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const RO = { readOnlyHint: true, openWorldHint: false };
const W = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const link = (id: string) => `/app/boards/${id}`;
/** Widget types that touch the outside: adding them always needs the person's confirmation. */
const HIGH = new Set(['embed', 'actions']);

const OPS_DOC = `ops = Liste von Änderungen (höchstens ${LIMITS.ops}), jede ein Objekt mit "op" und nur den passenden Feldern – unbekannte Felder und Typen sind Fehler:
• add: type (Widget-Typ aus ghl_board_widgets), optional title, config {Feld: Wert}, ref (eigene Bezeichnung für spätere Schritte), w/h (Größe im 12-Spalten-Raster), placement ("top", "bottom", "beside:<id|ref>", "below:<id|ref>", "above:<id|ref>") oder x/y
• remove: id
• move: id und placement oder x/y (bp: lg|md|sm; sm = Reihenfolge auf dem Handy)
• resize: id und w/h oder dw/dh (relativ, z. B. dw 2 = zwei Spalten breiter)
• configure: id und config (nur zu ändernde Felder; null setzt ein Feld zurück) und/oder title
• rename: name und/oder icon
• theme: accent (blau, grün, violett, orange, rot, türkis, rosa, grau oder #rrggbb; "" = zurücksetzen)
Reihenfolge zählt. Mit dry_run: true wird nur geprüft und die Vorschau (changes, risk) zurückgegeben – nichts gespeichert.`;

export const BOARD_TOOLS: Tool[] = [
  {
    name: 'ghl_board_list',
    title: 'Living Boards: Liste',
    description: 'Die Boards (Arbeitsbereiche aus Widgets), die die Person im Sub-Account sehen darf: eigene persönliche und geteilte. Mit Name, Symbol, Zugriff (owner/edit/view), Version, Anzahl Widgets und dem Board, das als Startseite gesetzt ist.',
    inputSchema: obj({ ...LOC }, ['location_id']),
    annotations: RO,
    run: async (call, a) => {
      const r = await call.api('GET', '/api/boards', { location: a.location_id });
      return {
        boards: (r.boards as any[]).map((b) => ({ id: b.id, name: b.name, icon: b.icon, scope: b.scope, access: b.access, version: b.version, widgets: b.widgets, owner: b.owner_name, updated_at: b.updated_at, home: b.home, link: link(b.id) })),
        home: r.home,
      };
    },
  },
  {
    name: 'ghl_board_get',
    title: 'Living Boards: Board lesen',
    description: 'Ein Board mit allen Widgets: id, Typ, Titel, Einstellungen (config) und Platz im 12-Spalten-Raster (layout.lg: x, y, w, h), Version und Zugriff. Mit with_data: true auch, was die Widgets gerade für die Person zeigen (Zahlen, Listen …) – so lässt sich ein Board zusammenfassen oder erklären.',
    inputSchema: obj({ ...LOC, board_id: { type: 'string' }, with_data: { type: 'boolean', description: 'Auch die aktuellen Daten der Widgets liefern (Standard false)' } }, ['location_id', 'board_id']),
    annotations: RO,
    run: async (call, a) => {
      const id = encodeURIComponent(a.board_id);
      const b = await call.api('GET', `/api/boards/${id}`, { location: a.location_id });
      const widgets = (b.spec.widgets as any[]).map((w) => ({ id: w.id, type: w.type, title: w.title, config: w.config, layout: { lg: w.layout.lg } }));
      const data = a.with_data ? (await call.api('GET', `/api/boards/${id}/data`, { location: a.location_id })).data : undefined;
      return {
        id: b.id,
        name: b.name,
        icon: b.icon,
        accent: b.accent,
        scope: b.scope,
        access: b.access,
        can_edit: b.access !== 'view',
        version: b.version,
        can_undo: b.can_undo,
        widgets: widgets.map((w) => ({ ...w, ...(data?.[w.id] ? { data: data[w.id].view } : {}) })),
        link: link(b.id),
      };
    },
  },
  {
    name: 'ghl_board_apply_patch',
    title: 'Living Boards: Board ändern',
    description: `Ändert ein Board mit einem validierten Patch: Widgets hinzufügen, entfernen, verschieben, vergrößern, konfigurieren, Board umbenennen, Akzentfarbe setzen. Jede Änderung wird eine Version (die Person kann sie in der Oberfläche sofort rückgängig machen) und erscheint live bei allen, die das Board offen haben. Ungültiges wird mit Gründen abgelehnt, nichts wird halb angewendet. Lies vorher ghl_board_widgets (Typen und Felder) und ghl_board_get (ids, Version); prüfe bei Unsicherheit mit dry_run. Fügst du eine Einbettung (embed) oder Schnellaktions-Knöpfe (actions) hinzu oder änderst sie, frage die Person erst und setze danach confirm_external: true. ${OPS_DOC}`,
    inputSchema: obj(
      {
        ...LOC,
        board_id: { type: 'string' },
        ops: { type: 'array', items: { type: 'object', properties: { op: { type: 'string', enum: OP_NAMES } }, required: ['op'] }, description: 'Die Änderungen (siehe Beschreibung)' },
        dry_run: { type: 'boolean', description: 'Nur prüfen und Vorschau liefern' },
        expected_version: { type: 'integer', description: 'Version aus ghl_board_get: schlägt mit 409 fehl, wenn das Board sich inzwischen geändert hat' },
        summary: { type: 'string', description: 'Kurzer Satz für den Versionsverlauf (sonst automatisch)' },
        confirm_external: { type: 'boolean', description: 'Die Person hat bestätigt, dass Adressen eingebettet bzw. Knöpfe angelegt werden dürfen' },
      },
      ['location_id', 'board_id', 'ops'],
    ),
    annotations: W,
    klassFor: (a) => (a.dry_run ? 'read' : Array.isArray(a.ops) && (a.ops as any[]).some((o) => o?.op === 'add' && HIGH.has(String(o?.type))) ? 'sensitive' : 'write'),
    run: async (call, a) => {
      const id = encodeURIComponent(a.board_id);
      // A check is a read (its own route); only the real thing writes.
      const r = a.dry_run === true ? await call.api('POST', `/api/boards/${id}/preview`, { location: a.location_id, body: { ops: a.ops } }) : await call.api('POST', `/api/boards/${id}/patch`, { location: a.location_id, body: { ops: a.ops, expected_version: a.expected_version, summary: a.summary, confirm_external: a.confirm_external === true } });
      return { ...(r.board ? { board: { id: r.board.id, name: r.board.name, version: r.board.version, widgets: r.board.widgets } } : {}), ok: r.ok, ...(r.errors ? { errors: r.errors } : {}), unchanged: r.unchanged, version: r.version, summary: r.summary, risk: r.risk, changes: r.changes, created: r.created, saved: a.dry_run ? false : !r.unchanged, link: link(a.board_id) };
    },
  },
  {
    name: 'ghl_board_widgets',
    title: 'Living Boards: Widget-Katalog',
    description: 'Alle Widget-Typen, die ein Board enthalten kann – mit Beschreibung, Standardgröße, den Einstellungsfeldern (key, Beschriftung, Art, erlaubte Werte) und dem Bereich, dessen Rechte für die Daten gelten. Module können weitere Typen ergänzen. Grundlage für ghl_board_apply_patch.',
    inputSchema: obj({ location_id: { type: 'string', description: 'Sub-Account-ID (bei Agentur-Schlüsseln nötig)' } }),
    annotations: RO,
    run: async (call, a) => {
      const r = await call.api('GET', '/api/boards/widgets', { location: a.location_id });
      return {
        widgets: (r.widgets as any[]).map((w) => ({ type: w.type, label: w.label, description: w.description, category: w.category_label, size: w.size, risk: w.risk, access: w.access_label || undefined, fields: (w.fields as any[]).filter((f) => !f.hidden || f.type === 'json').map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options?.map(([v, l]: [string, string]) => `${v || '(leer)'}=${l}`), from: f.optionsFrom, min: f.min, max: f.max, default: f.default, only_if: f.showIf ? `${f.showIf.key} in ${f.showIf.in.join('|')}` : undefined, item: f.item?.map((i: any) => i.key) })) })),
        limits: r.limits,
        hint: 'ids für Felder wie pipeline_id, report_id, workflow_id liefern die Werkzeuge der jeweiligen Bereiche (ghl_list_pipelines, ghl_list_dashboards …); ohne Angabe gelten Standardwerte.',
      };
    },
  },
  {
    name: 'ghl_board_create',
    title: 'Living Boards: Board anlegen',
    description: 'Legt ein neues Board an – leer oder aus einer Vorlage (solo-cockpit, vertrieb, agentur, service, projekte oder die ID einer eigenen Vorlage des Sub-Accounts). scope personal (nur die Person) oder shared (Team, Standard nur lesen). Danach mit ghl_board_apply_patch anpassen.',
    inputSchema: obj({ ...LOC, name: { type: 'string' }, template: { type: 'string', description: 'Vorlage: solo-cockpit, vertrieb, agentur, service, projekte oder Vorlagen-ID' }, scope: { type: 'string', enum: ['personal', 'shared'] }, team_access: { type: 'string', enum: ['view', 'edit'] } }, ['location_id']),
    annotations: W,
    run: async (call, a) => {
      const b = await call.api('POST', '/api/boards', { location: a.location_id, body: { name: a.name, template: a.template, scope: a.scope ?? (call.agency ? 'shared' : 'personal'), team_access: a.team_access } });
      return { id: b.id, name: b.name, scope: b.scope, version: b.version, widgets: b.widgets, link: link(b.id) };
    },
  },
];

export const boardsToolsModule: Module = {
  name: 'boards-tools',
  register(app) {
    const { router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...BOARD_TOOLS];

    // The HyperLevel Agent knows what boards are and how to change them.
    app.services.agentPromptExtras = [
      ...(app.services.agentPromptExtras ?? []),
      (i: { user: any; locationId: string; automatic: boolean }) =>
        i.automatic
          ? ''
          : [
              '# Living Boards',
              'Boards sind Arbeitsbereiche aus Widgets (Kennzahlen, Diagramme, Listen, Pipeline, Termine, Aufgaben …), persönlich oder geteilt. Soll ein Board geändert werden („zeig mir oben die offenen Deals“, „mach die Umsatzkurve größer“): ghl_board_list → ghl_board_get (ids, Version) → ghl_board_widgets (Typen und Felder) → ghl_board_apply_patch. Prüfe unsichere Patches erst mit dry_run und beschreibe der Person in einem Satz, was sich ändert. Jede Änderung ist eine Version; in der Oberfläche macht „Rückgängig“ sie sofort zurück.',
              'Einbettungen (embed) und Schnellaktions-Knöpfe (actions) berühren die Außenwelt: frage die Person vorher und setze erst dann confirm_external. Kann kein Widget den Wunsch erfüllen, erfinde nichts – schlage vor, ein passendes Widget in der Werkstatt bauen zu lassen (Plugins können Widgets liefern).',
            ].join('\n'),
    ];

    // --- native app (bearer ghm_…): read only --------------------------------------------------------------------------------
    const B = () => app.services.boards as any;
    /** Loads a board the way the web app would for this person, in the sub-account the app names. */
    const open = (ctx: Ctx) => {
      const l = bodyLocation(app, ctx, ctx.query.get('location'));
      checkArea(app, ctx, l.id, 'dashboard');
      const c: Ctx = { ...ctx, locationId: l.id };
      return { l, c, ...(B().load(c, ctx.params.id, 'view') as { board: BoardRow; access: string }) };
    };

    router.get('/api/mobile/boards', 'user', (ctx) => {
      const locs = scope(app, ctx, 'dashboard', { strict: false });
      const out: Record<string, unknown>[] = [];
      for (const l of locs) {
        const c: Ctx = { ...ctx, locationId: l.id };
        const home = B().homeId(c);
        for (const { board, access } of B().list(c) as { board: BoardRow; access: string }[]) {
          out.push({ id: board.id, location_id: l.id, location_name: l.name, name: board.name, icon: board.icon, accent: board.accent, scope: board.scope, access, widgets: parseSpec(board.spec).widgets.length, version: board.head, updated_at: board.updated_at, home: home === board.id });
        }
      }
      return { boards: out };
    });
    router.get('/api/mobile/boards/:id', 'user', (ctx) => {
      const { l, c, board, access } = open(ctx);
      const spec = parseSpec(board.spec);
      return {
        id: board.id,
        location_id: l.id,
        name: board.name,
        icon: board.icon,
        accent: board.accent,
        scope: board.scope,
        access,
        version: board.head,
        updated_at: board.updated_at,
        // The phone shows one column: the "sm" order, with the heights in grid rows.
        widgets: spec.widgets
          .map((w) => ({ id: w.id, type: w.type, title: w.title || B().registry.get(w.type)?.label || w.type, layout: { sm: w.layout.sm ?? { x: 0, y: 0, w: 1, h: w.layout.lg.h }, lg: w.layout.lg } }))
          .sort((a, b) => a.layout.sm.y - b.layout.sm.y),
        home: B().homeId(c) === board.id,
      };
    });
    router.get('/api/mobile/boards/:id/data', 'user', async (ctx) => {
      const { c, board } = open(ctx);
      ctx.skipAfterWrite = true;
      const ids = String(ctx.query.get('ids') ?? '').split(',').filter(Boolean).slice(0, LIMITS.widgets);
      const data = await B().data(c, board, ids.length ? ids : undefined);
      return { version: board.head, data };
    });
  },
};
