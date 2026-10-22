import { createHash } from 'node:crypto';
import type { App } from '../core/app.js';
import { HttpError } from '../core/http.js';
import type { Row } from '../core/db.js';
import { actorOf as canvasActor, createSnapshot, restoreSnapshot, type BoardRow } from './canvas-store.js';
import { canonical, encodeRow } from './undo-core.js';
import type { Journal } from './undo-journal.js';
import { clip, tableEntity, type FieldSpec, type UndoEntity } from './undo-table.js';
import { loadPage, restorePage, trashPage, updatePage } from './wiki-store.js';

/**
 * Records that already keep their own version history – workflows, wiki pages, canvas boards – are not copied into
 * the journal again. The entry points at the version the record had before ("vorherige Version wiederherstellen"),
 * and putting it back goes through the module's own restore (which adds a version of its own, so the history shows it).
 *
 * - Workflow: the journal stores name/status and the hash of the content; the content comes from `workflow_versions`.
 * - Canvas: before an agent or an API key changes a board, a snapshot of the board is secured (`canvas_snapshots`);
 *   people editing in the browser have the editor's own undo and are not journaled.
 * - Wiki: edits arrive as autosaves that the wiki itself merges into one version, so the page text is kept in the entry
 *   (coalesced per person and ten minutes); deleting a page is the wiki's own trash, restored through its restore.
 */

const json = <T>(v: unknown, fallback: T): T => {
  try {
    return typeof v === 'string' ? (JSON.parse(v) as T) : ((v as T) ?? fallback);
  } catch {
    return fallback;
  }
};
const F = (label: string, fmt?: FieldSpec['fmt']): FieldSpec => ({ label, fmt });
const sha = (v: unknown) => createHash('sha1').update(canonical(v)).digest('hex').slice(0, 24);

export function registerVersionedEntities(app: App, undo: Journal) {
  const { db } = app;

  // --- workflows ----------------------------------------------------------------------------------------------------
  const wfv = () => app.services.workflowVersions as { hashOf: (w: { trigger: unknown; steps: unknown; settings: unknown }) => string; snapshot: (loc: string, w: any, ctx: any, note?: string) => void } | undefined;
  const STATUS: Record<string, string> = { draft: 'Entwurf', active: 'aktiv', paused: 'pausiert' };
  const wfBase = tableEntity(app, {
    noun: 'Automation',
    plural: 'Automationen',
    area: 'workflows',
    table: 'workflows',
    title: (r) => String(r.name),
    contactCol: null,
    volatile: ['updated_at'],
    fields: { name: F('Name'), status: F('Status', (v) => STATUS[String(v)] ?? String(v)), _version: F('Version', (v) => (v ? `Version ${v}` : 'Entwurf')) },
    verb: (b, a) => (!a ? 'gelöscht' : b && b.row.status !== a.row.status ? (a.row.status === 'active' ? 'aktiviert' : a.row.status === 'paused' ? 'pausiert' : 'auf Entwurf gesetzt') : undefined),
  });
  const workflow: UndoEntity = {
    ...wfBase,
    snapshot(id, ctx, mode) {
      const s = wfBase.snapshot(id, ctx, mode);
      const hasher = wfv();
      if (!s || mode === 'deep' || !hasher) return s;
      const hash = hasher.hashOf({ trigger: json(s.row.trigger, {}), steps: json(s.row.steps, []), settings: json(s.row.settings, {}) });
      const ver = db.get<{ version: number }>('SELECT version FROM workflow_versions WHERE workflow_id = ? AND hash = ? ORDER BY version DESC LIMIT 1', id, hash);
      // The content lives in the version history: the entry keeps only which version it was.
      if (ver) {
        const { trigger: _t, steps: _s, settings: _x, ...rest } = s.row;
        s.row = { ...rest, _hash: hash, _version: ver.version };
      } else s.row = { ...s.row, _hash: hash };
      return s;
    },
    restore(target, ctx, current) {
      let t = target;
      if (t && !('steps' in t.row) && t.row._hash) {
        const ver = db.get<Row>('SELECT * FROM workflow_versions WHERE workflow_id = ? AND hash = ? ORDER BY version DESC LIMIT 1', t.id, t.row._hash as string);
        if (!ver) throw new HttpError(409, 'Die frühere Fassung steckt nicht mehr im Versionsverlauf der Automation (er behält die letzten 50 Versionen)');
        t = { ...t, row: { ...t.row, trigger: ver.trigger, steps: ver.steps, settings: ver.settings } };
      }
      wfBase.restore(t, ctx, current);
      // The restore is a version of its own, so the version history tells the story.
      const w = t && db.get<Row>('SELECT * FROM workflows WHERE id = ?', t.id);
      if (w) wfv()?.snapshot(ctx.locationId, { id: w.id, name: w.name, trigger: json(w.trigger, {}), steps: json(w.steps, []), settings: json(w.settings, {}) }, ctx, 'Wiederhergestellt (Rückgängig)');
    },
  };
  undo.register('workflow', workflow);
  undo.track({ method: 'PATCH', pattern: '/api/workflows/:id', entity: 'workflow', action: (b, a) => (b && a && b.row.status !== a.row.status ? 'status' : 'update') });
  undo.track({ method: 'DELETE', pattern: '/api/workflows/:id', entity: 'workflow', notice: 'Läufe, die gerade auf einen Schritt warten, kommen mit zurück und machen weiter.' });

  // --- wiki ------------------------------------------------------------------------------------------------------------
  const wikiTable = !!db.get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'wiki_pages'`);
  const wiki: UndoEntity = {
    noun: 'Wiki-Seite',
    plural: 'Wiki-Seiten',
    area: 'wiki',
    volatile: ['updated_at', 'version', 'updated_by', 'updated_by_name', 'text', 'position', 'kb_version'],
    fields: { title: F('Titel'), body: F('Inhalt', (v) => `${String(v ?? '').length.toLocaleString('de-DE')} Zeichen`), icon: F('Symbol'), trashed_at: F('Im Papierkorb seit', 'datetime') },
    snapshot(id, ctx) {
      const row = db.get<Row>('SELECT id, location_id, space_id, parent_id, position, title, icon, body, trashed_at FROM wiki_pages WHERE id = ?' + (ctx?.locationId ? ' AND location_id = ?' : ''), id, ...(ctx?.locationId ? [ctx.locationId] : []));
      return row ? { v: 1, entity: 'wiki_pages', id, row: encodeRow(row) } : null;
    },
    label: (s) => `Wiki-Seite „${clip(s.row.title, 60)}“`,
    verb: (b, a) => (!a ? 'gelöscht' : b && !b.row.trashed_at && a.row.trashed_at ? 'in den Papierkorb gelegt' : b?.row.trashed_at && !a.row.trashed_at ? 'wiederhergestellt' : undefined),
    restore(target, ctx, current) {
      if (!target || !current) return;
      let loaded;
      try {
        loaded = loadPage(app, ctx, target.id, 'edit', { trashed: true });
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) throw new HttpError(410, 'Die Wiki-Seite wurde endgültig gelöscht');
        throw e;
      }
      const { page, space } = loaded;
      if (current.row.trashed_at && !target.row.trashed_at) restorePage(app, page);
      else if (!current.row.trashed_at && target.row.trashed_at) trashPage(app, page);
      const now = db.get<Row>('SELECT * FROM wiki_pages WHERE id = ?', target.id) as any;
      if (now && (now.title !== target.row.title || now.body !== target.row.body || now.icon !== target.row.icon)) updatePage(app, ctx, now, space, { title: target.row.title as string, body: target.row.body as string, icon: target.row.icon as string }, { force: true, note: 'Wiederhergestellt (Rückgängig)' });
    },
  };
  if (wikiTable) {
    undo.register('wiki_page', wiki);
    // Autosaves: one entry per person, page and ten minutes. The route silences the after-write hooks, so it asks to be recorded when the answer is out.
    undo.track({ method: 'PATCH', pattern: '/api/wiki/pages/:id', entity: 'wiki_page', coalesceMs: 10 * 60_000, quiet: true });
    undo.track({ method: 'DELETE', pattern: '/api/wiki/pages/:id', entity: 'wiki_page', deep: false, when: (_b, a) => !!a?.row.trashed_at });
  }

  // --- canvas -----------------------------------------------------------------------------------------------------------
  const boardVolatile = ['updated_at', 'seq', 'element_count', 'last_snapshot_at', 'updated_by'];
  const boardBase = tableEntity(app, {
    noun: 'Canvas-Board',
    plural: 'Canvas-Boards',
    area: 'canvas',
    table: 'canvas_boards',
    title: (r) => String(r.name),
    contactCol: null,
    volatile: boardVolatile,
    keep: boardVolatile,
    fields: { name: F('Name'), description: F('Beschreibung'), team_access: F('Team-Zugriff'), settings: F('Einstellungen', 'json'), _hash: F('Inhalt', () => 'Elemente geändert') },
  });
  const content = (id: string) => sha(db.all<{ id: string; version: number; deleted: number }>('SELECT id, version, deleted FROM canvas_elements WHERE board_id = ? ORDER BY id', id).map((e) => [e.id, e.version, e.deleted]));
  /** The board's elements are identified by their versions; "before" a change by an agent or key a snapshot of them is secured. */
  const withContent = (mode: 'meta' | 'content'): UndoEntity => ({
    ...boardBase,
    snapshot(id, ctx, m) {
      const s = boardBase.snapshot(id, ctx, m);
      if (!s || m === 'deep') return s;
      s.row = { ...s.row, _hash: content(id) };
      if (mode === 'content' && m === 'before') {
        const board = db.get<BoardRow>('SELECT * FROM canvas_boards WHERE id = ?', id)!;
        const same = db.get<{ id: string }>('SELECT id FROM canvas_snapshots WHERE board_id = ? AND seq = ? ORDER BY created_at DESC LIMIT 1', id, board.seq);
        const snapId = same?.id ?? (board.element_count || db.get('SELECT 1 AS x FROM canvas_elements WHERE board_id = ? LIMIT 1', id) ? createSnapshot(app, id, `Vor Änderung durch ${ctx ? canvasActor(app, ctx).name : 'Rückgängig'}`, true, ctx ? canvasActor(app, ctx) : ({ name: 'Rückgängig' } as any)).id : undefined);
        if (snapId) s.extra = { snapshot_id: snapId };
      }
      return s;
    },
    restore(target, ctx, current) {
      boardBase.restore(target, ctx, current);
      const snapId = target?.extra?.snapshot_id as string | undefined;
      if (!target || !snapId) return;
      const board = db.get<BoardRow>('SELECT * FROM canvas_boards WHERE id = ? AND location_id = ?', target.id, ctx.locationId);
      if (!board) return;
      if (!db.get('SELECT 1 AS x FROM canvas_snapshots WHERE id = ?', snapId)) throw new HttpError(409, 'Die gesicherte Fassung des Boards ist nicht mehr da (der Versionsverlauf behält die letzten 30 automatischen Sicherungen)');
      restoreSnapshot(app, ctx, board, snapId);
    },
    verb: (b, a) => (!a ? 'gelöscht' : mode === 'content' ? 'bearbeitet' : undefined),
  });
  undo.register('canvas', withContent('meta'));
  undo.register('canvas_content', withContent('content'));
  undo.track({ method: 'PATCH', pattern: '/api/canvas/:id', entity: 'canvas', targets: (ctx) => (ctx.via === 'session' && ctx.body?.name === undefined ? [] : [{ id: ctx.params.id }]) });
  undo.track({ method: 'DELETE', pattern: '/api/canvas/:id', entity: 'canvas' });
  // Agents, MCP and API keys change boards through these routes; people in the editor have its own undo (and their writes stay quiet).
  for (const route of ['ops', 'elements', 'template', 'mermaid', 'layout', 'cards']) {
    undo.track({ method: 'POST', pattern: `/api/canvas/:id/${route}`, entity: 'canvas_content', targets: (ctx) => (ctx.via === 'session' ? [] : [{ id: ctx.params.id }]), action: 'update' });
  }
}

