import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, str } from '../core/http.js';
import { id, now } from '../core/util.js';
import type { Tool } from './mcp.js';

/**
 * Reports, Claude artifacts and other documents, filed under the project they belong to.
 * Anything that cannot be matched lands in the agency inbox (location_id NULL) until someone
 * assigns it. Upserts are keyed by URL and never undo a manual assignment.
 */

export const DOC_KINDS = ['artifact', 'report', 'doc', 'session', 'link'];

const cleanUrl = (v: unknown) => {
  const s = str(v, 'Link', { required: true, max: 1000 });
  if (!/^https:\/\/[^\s]+$/i.test(s)) throw bad('Link: bitte mit https:// angeben');
  return s;
};

/** Kind and source from well-known links when the caller says nothing: Claude artifacts, ChatGPT/Codex links. */
export function guessDoc(url: string): { kind: string; source: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const path = u.pathname;
  if (host === 'claude.ai' || host === 'claude.com') {
    if (path.startsWith('/artifact') || path.includes('/artifacts/')) return { kind: 'artifact', source: 'Claude' };
    if (path.startsWith('/code') || path.startsWith('/chat') || path.startsWith('/share')) return { kind: 'session', source: 'Claude' };
    return { kind: 'link', source: 'Claude' };
  }
  if (host === 'chatgpt.com' || host === 'chat.openai.com') {
    if (path.startsWith('/codex')) return { kind: 'session', source: 'Codex' };
    if (path.startsWith('/canvas')) return { kind: 'artifact', source: 'ChatGPT' };
    if (path.startsWith('/share') || path.startsWith('/c/')) return { kind: 'doc', source: 'ChatGPT' };
    return { kind: 'link', source: 'ChatGPT' };
  }
  return null;
}

interface DocIn {
  url: string;
  title?: string;
  kind?: string;
  location_id?: string | null;
  source?: string;
  session_url?: string;
  summary?: string;
  updated_at?: string;
}

/** Inserts or refreshes documents by URL. `force` moves already assigned documents too. */
export function saveDocs(app: App, list: DocIn[], opts: { locationId?: string | null; force?: boolean } = {}) {
  const { db } = app;
  let created = 0;
  let updated = 0;
  for (const raw of list.slice(0, 500)) {
    const url = cleanUrl(raw.url);
    const guess = guessDoc(url);
    const kind = DOC_KINDS.includes(String(raw.kind)) ? String(raw.kind) : (guess?.kind ?? 'artifact');
    const loc = raw.location_id !== undefined ? raw.location_id || null : (opts.locationId ?? null);
    if (loc && !app.location(loc)) throw bad(`Projekt ${loc} gibt es nicht`);
    const at = raw.updated_at && !Number.isNaN(Date.parse(raw.updated_at)) ? new Date(raw.updated_at).toISOString() : now();
    const fields = {
      title: str(raw.title, 'Titel', { max: 300 }) || url,
      kind,
      source: str(raw.source, 'Quelle', { max: 100 }) || guess?.source || '',
      session_url: raw.session_url ? cleanUrl(raw.session_url) : null,
      summary: str(raw.summary, 'Zusammenfassung', { max: 2000 }),
      updated_at: at,
    };
    const cur = db.get('SELECT id, location_id FROM docs WHERE url = ?', url);
    if (cur) {
      // Keep a manual assignment unless the caller insists.
      const location_id = opts.force || !cur.location_id ? (loc ?? cur.location_id) : cur.location_id;
      db.run('UPDATE docs SET title = ?, kind = ?, source = ?, session_url = COALESCE(?, session_url), summary = CASE WHEN ? = \'\' THEN summary ELSE ? END, updated_at = ?, location_id = ? WHERE id = ?', fields.title, fields.kind, fields.source, fields.session_url, fields.summary, fields.summary, fields.updated_at, location_id, cur.id);
      updated++;
    } else {
      db.insert('docs', { id: id(), url, location_id: loc, pinned: 0, created_at: now(), ...fields });
      created++;
    }
  }
  return { created, updated };
}

const SELECT = `SELECT d.*, l.name AS project FROM docs d LEFT JOIN locations l ON l.id = d.location_id`;

const TOOLS: Tool[] = [
  {
    name: 'ghl_list_docs',
    title: 'Berichte & Artefakte',
    description: 'Berichte, Claude-/ChatGPT-Artefakte, Codex-Aufgaben und Dokumente – pro Projekt (location_id) oder alle; unassigned=true zeigt den Eingang ohne Projekt.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, unassigned: { type: 'boolean' }, query: { type: 'string' } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) =>
      call.agency
        ? call.api('GET', `/api/agency/docs?${new URLSearchParams({ ...(a.location_id ? { location_id: a.location_id } : {}), ...(a.unassigned ? { unassigned: '1' } : {}), ...(a.query ? { q: a.query } : {}) })}`)
        : call.api('GET', '/api/docs'),
  },
  {
    name: 'ghl_save_docs',
    title: 'Berichte & Artefakte ablegen',
    description:
      'Legt Dokumente per URL ab oder aktualisiert sie (z. B. Claude-Artefakte von claude.ai/artifact/…, ChatGPT-Canvas/-Chats oder Codex-Aufgaben von chatgpt.com – Art und Quelle werden dann erkannt, wenn kind/source fehlen). docs: [{url, title, kind: artifact|report|doc|session|link, location_id?, source?, session_url?, summary?, updated_at?}]. Ohne location_id landet ein neues Dokument im Eingang. Eine manuelle Zuordnung bleibt erhalten, außer force=true.',
    inputSchema: {
      type: 'object',
      properties: { docs: { type: 'array', items: { type: 'object' } }, force: { type: 'boolean' } },
      required: ['docs'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    agencyOnly: true,
    run: (call, a) => call.api('POST', '/api/agency/docs', { body: { docs: a.docs, force: !!a.force } }),
  },
  {
    name: 'ghl_assign_doc',
    title: 'Dokument einem Projekt zuordnen',
    description: 'Ordnet ein Dokument (id aus ghl_list_docs) einem Projekt zu; location_id leer = zurück in den Eingang. pinned hebt es im Projekt hervor.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, location_id: { type: 'string' }, pinned: { type: 'boolean' } }, required: ['id'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    agencyOnly: true,
    run: (call, a) => call.api('PATCH', `/api/agency/docs/${encodeURIComponent(a.id)}`, { body: { ...(a.location_id !== undefined ? { location_id: a.location_id } : {}), ...(a.pinned !== undefined ? { pinned: a.pinned } : {}) } }),
  },
];

export const docsModule: Module = {
  name: 'docs',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE docs (
        id TEXT PRIMARY KEY, location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
        url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'artifact',
        source TEXT NOT NULL DEFAULT '', session_url TEXT, summary TEXT NOT NULL DEFAULT '',
        pinned INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX docs_location ON docs(location_id, updated_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    app.services.saveDocs = (list: DocIn[], opts?: { locationId?: string | null; force?: boolean }) => saveDocs(app, list, opts);

    // --- per project ---
    router.get('/api/docs', 'location', (ctx) => db.all(`${SELECT} WHERE d.location_id = ? ORDER BY d.pinned DESC, d.updated_at DESC`, ctx.locationId));
    router.post('/api/docs', 'location', (ctx) => {
      // URLs are unique across the agency: a link filed under another project (or still in the agency inbox)
      // must not be moved here by a client login or key – that would hand over another tenant's document.
      const url = cleanUrl(ctx.body?.url);
      const cur = db.get('SELECT location_id FROM docs WHERE url = ?', url);
      if (cur && cur.location_id !== ctx.locationId && !(ctx.user?.role === 'admin' && ctx.via === 'session')) throw new HttpError(409, 'Dieser Link ist schon einem anderen Projekt zugeordnet');
      const r = saveDocs(app, [{ ...ctx.body, url, location_id: ctx.locationId }], { force: true });
      return { ...r, doc: db.get(`${SELECT} WHERE d.url = ? AND d.location_id = ?`, url, ctx.locationId) };
    });
    router.patch('/api/docs/:id', 'location', (ctx) => {
      const d = db.get('SELECT * FROM docs WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!d) throw notFound();
      if (ctx.body.pinned !== undefined) db.run('UPDATE docs SET pinned = ? WHERE id = ?', ctx.body.pinned ? 1 : 0, d.id);
      if (ctx.body.title !== undefined) db.run('UPDATE docs SET title = ? WHERE id = ?', str(ctx.body.title, 'Titel', { required: true, max: 300 }), d.id);
      return db.get(`${SELECT} WHERE d.id = ?`, d.id);
    });
    router.delete('/api/docs/:id', 'location', (ctx) => {
      if (!db.run('DELETE FROM docs WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId).changes) throw notFound();
      return { ok: true };
    });

    // --- agency: everything, plus the inbox of unassigned documents ---
    router.get('/api/agency/docs', 'admin', (ctx) => {
      const where: string[] = [];
      const params: any[] = [];
      if (ctx.query.get('unassigned')) where.push('d.location_id IS NULL');
      const loc = ctx.query.get('location_id');
      if (loc) (where.push('d.location_id = ?'), params.push(loc));
      const q = (ctx.query.get('q') ?? '').trim();
      if (q) (where.push('(d.title LIKE ? OR d.summary LIKE ? OR d.url LIKE ?)'), params.push(`%${q}%`, `%${q}%`, `%${q}%`));
      return db.all(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.updated_at DESC LIMIT 2000`, ...params);
    });
    router.post('/api/agency/docs', 'admin', (ctx) => {
      if (!Array.isArray(ctx.body?.docs)) throw bad('docs: Liste erwartet');
      return saveDocs(app, ctx.body.docs, { force: !!ctx.body.force });
    });
    router.patch('/api/agency/docs/:id', 'admin', (ctx) => {
      const d = db.get('SELECT * FROM docs WHERE id = ?', ctx.params.id);
      if (!d) throw notFound();
      if (ctx.body.location_id !== undefined) {
        const loc = ctx.body.location_id || null;
        if (loc && !app.location(loc)) throw bad('Projekt gibt es nicht');
        db.run('UPDATE docs SET location_id = ? WHERE id = ?', loc, d.id);
      }
      if (ctx.body.pinned !== undefined) db.run('UPDATE docs SET pinned = ? WHERE id = ?', ctx.body.pinned ? 1 : 0, d.id);
      return db.get(`${SELECT} WHERE d.id = ?`, d.id);
    });
    router.delete('/api/agency/docs/:id', 'admin', (ctx) => {
      if (!db.run('DELETE FROM docs WHERE id = ?', ctx.params.id).changes) throw notFound();
      return { ok: true };
    });
  },
};
