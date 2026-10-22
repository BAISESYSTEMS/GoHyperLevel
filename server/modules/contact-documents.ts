import type { Module } from '../core/app.js';
import { bad, notFound, type Ctx, type RawResult } from '../core/http.js';
import { contentMatches } from '../core/files.js';
import { id, now } from '../core/util.js';
import { resolve, scopeClause } from '../services/record-access.js';
import type { Tool } from './mcp.js';

/**
 * Documents on a contact and attachments on notes (docs/api.md#contact-documents): photos, PDFs and office files in a contact's
 * notes tab, either on the contact itself or on one of its notes. The bytes live in the database (BLOB in `contact_document_blobs`) – never on a public URL, served
 * only through the signed-in route below, with nosniff and a sandbox CSP – so backups, the tenant export and deleting the contact
 * (cascade) take them along. A file can be "nur für mich": then only the person who added it and admins see it. Record access
 * applies: who cannot see the contact cannot see its files.
 *
 * Limits: 8 MB per file, 200 files per contact, PGHL_CONTACT_DOCS_MB per sub-account (default 2048, 0 = no cap).
 */

const MB = 1024 * 1024;
export const DOC_MAX = 8 * MB;
const PER_CONTACT = 200;

export const DOC_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
};
const BY_EXT: Record<string, string> = Object.fromEntries([...Object.entries(DOC_TYPES).map(([m, e]) => [e, m]), ['jpeg', 'image/jpeg']]);

/** The sub-account's cap in bytes (null = none). */
export function docsCap(): number | null {
  const raw = process.env.PGHL_CONTACT_DOCS_MB;
  const mb = raw === undefined || raw.trim() === '' ? 2048 : Number(raw);
  if (!Number.isFinite(mb) || mb < 0) return 2048 * MB;
  return mb === 0 ? null : Math.round(mb * MB);
}

/** A file name without paths, control characters or quotes (it goes into a header). */
export function cleanName(v: unknown): string {
  // eslint-disable-next-line no-control-regex
  const s = String(v ?? '').normalize('NFC').replace(/^.*[\\/]/, '').replace(/[\x00-\x1f\x7f"]/g, '').trim().slice(0, 180);
  if (!s) throw bad('name: Dateiname fehlt');
  return s;
}

const META = 'd.id, d.contact_id, d.note_id, d.name, d.mime, d.size, d.private, d.created_by, d.created_at';

const TOOLS: Tool[] = [
  {
    name: 'ghl_contact_documents',
    title: 'Dokumente eines Kontakts auflisten',
    description: 'Dateien am Kontakt und an seinen Notizen (Name, Typ, Größe, Notiz, Datum, wer sie hochgeladen hat) – ohne Inhalt. „Nur für mich“-Dateien anderer Personen fehlen.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, contact_id: { type: 'string' } }, required: ['contact_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/contacts/${encodeURIComponent(String(a.contact_id))}/documents`, { location: a.location_id }),
  },
];

export const contactDocumentsModule: Module = {
  name: 'contact-documents',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE contact_documents (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
        name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
        private INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at TEXT NOT NULL
      );
      -- The bytes apart from the row: the DSGVO export lists the documents (name, type, size) without dumping their content.
      CREATE TABLE contact_document_blobs (doc_id TEXT PRIMARY KEY REFERENCES contact_documents(id) ON DELETE CASCADE, data BLOB NOT NULL);
      CREATE INDEX contact_documents_contact ON contact_documents(contact_id, created_at);
      CREATE INDEX contact_documents_note ON contact_documents(note_id);
      CREATE INDEX contact_documents_location ON contact_documents(location_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    app.services.bodyLimits = [...(app.services.bodyLimits ?? []), { match: (m: string, p: string) => m === 'POST' && /^\/api\/contacts\/[^/]+\/documents$/.test(p), bytes: Math.ceil(DOC_MAX * 1.4) + MB }];

    const isAdmin = (ctx: Ctx) => ctx.user?.role === 'admin' || (!ctx.user && !!ctx.viaApiKey);
    /** The contact, if the person may see it (sub-account + record access). */
    const contactOf = (ctx: Ctx, contactId: string) => {
      const scope = scopeClause(resolve(app, ctx), 'contacts', 'c');
      const c = db.get<{ id: string }>(`SELECT c.id FROM contacts c WHERE c.id = ? AND c.location_id = ?${scope ? ` AND ${scope.sql}` : ''}`, contactId, ctx.locationId, ...((scope?.params ?? []) as string[]));
      if (!c) throw notFound('Kontakt nicht gefunden');
      return c;
    };
    /** "Nur für mich" files are the uploader's and the admins'. */
    const visible = (ctx: Ctx) => (isAdmin(ctx) ? { sql: '', params: [] as string[] } : { sql: ' AND (d.private = 0 OR d.created_by = ?)', params: [ctx.user?.id ?? ''] });
    const docOf = (ctx: Ctx, withData = false) => {
      contactOf(ctx, ctx.params.id);
      const v = visible(ctx);
      const d = db.get<any>(`SELECT ${META}${withData ? ', (SELECT b.data FROM contact_document_blobs b WHERE b.doc_id = d.id) AS data' : ''} FROM contact_documents d WHERE d.id = ? AND d.contact_id = ? AND d.location_id = ?${v.sql}`, ctx.params.docId, ctx.params.id, ctx.locationId, ...v.params);
      if (!d) throw notFound('Datei nicht gefunden');
      return d;
    };
    const out = (d: any) => ({ ...d, private: !!d.private, url: `/api/contacts/${encodeURIComponent(d.contact_id)}/documents/${d.id}` });

    router.get('/api/contacts/:id/documents', 'location', (ctx) => {
      contactOf(ctx, ctx.params.id);
      const v = visible(ctx);
      const rows = db.all<any>(
        `SELECT ${META}, n.title AS note_title, u.name AS user_name FROM contact_documents d LEFT JOIN notes n ON n.id = d.note_id LEFT JOIN users u ON u.id = d.created_by
         WHERE d.contact_id = ? AND d.location_id = ?${v.sql} ORDER BY d.created_at DESC`,
        ctx.params.id,
        ctx.locationId,
        ...v.params,
      );
      return rows.map(out);
    });

    router.post('/api/contacts/:id/documents', 'location', (ctx) => {
      const c = contactOf(ctx, ctx.params.id);
      const name = cleanName(ctx.body?.name);
      const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
      const mime = String(ctx.body?.mime || BY_EXT[ext] || '').split(';')[0].trim().toLowerCase();
      if (!DOC_TYPES[mime]) throw bad('Dateityp nicht erlaubt (Bilder, PDF, Text, CSV, Word, Excel, PowerPoint, OpenDocument)');
      if (typeof ctx.body?.data !== 'string' || !ctx.body.data) throw bad('data: Inhalt als Base64 angeben');
      const buf = Buffer.from(ctx.body.data.replace(/^data:[^,]*;base64,/, '').replace(/\s+/g, ''), 'base64');
      if (!buf.length) throw bad('Die Datei ist leer');
      if (buf.length > DOC_MAX) throw bad(`Die Datei ist zu groß (höchstens ${DOC_MAX / MB} MB)`);
      if (!contentMatches(mime, buf)) throw bad('Der Inhalt passt nicht zum Dateityp');
      let noteId: string | null = null;
      if (ctx.body?.note_id) {
        const n = db.get<{ id: string }>('SELECT id FROM notes WHERE id = ? AND contact_id = ? AND location_id = ?', String(ctx.body.note_id), c.id, ctx.locationId);
        if (!n) throw bad('Die Notiz gehört nicht zu diesem Kontakt');
        noteId = n.id;
      }
      if (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contact_documents WHERE contact_id = ?', c.id)!.n >= PER_CONTACT) throw bad(`Höchstens ${PER_CONTACT} Dateien je Kontakt`);
      const cap = docsCap();
      if (cap !== null) {
        const used = db.get<{ s: number }>('SELECT COALESCE(SUM(size), 0) AS s FROM contact_documents WHERE location_id = ?', ctx.locationId)!.s;
        if (used + buf.length > cap) throw bad('Der Speicher für Kontakt-Dokumente ist voll');
      }
      const row = { id: id(), location_id: ctx.locationId, contact_id: c.id, note_id: noteId, name, mime, size: buf.length, private: ctx.body?.private ? 1 : 0, created_by: ctx.user?.id ?? null, created_at: now() };
      db.tx(() => {
        db.insert('contact_documents', row);
        db.insert('contact_document_blobs', { doc_id: row.id, data: buf });
      });
      const { location_id: _loc, ...meta } = row;
      return out(meta);
    });

    router.get('/api/contacts/:id/documents/:docId', 'location', (ctx) => {
      const d = docOf(ctx, true);
      const inline = ctx.query.get('inline') === '1' && /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(d.mime);
      return {
        __raw: true,
        status: 200,
        headers: {
          'content-type': d.mime,
          'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${d.name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(d.name)}`,
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; img-src 'self'; sandbox",
          'cache-control': 'private, no-store',
        },
        body: Buffer.from(d.data as Uint8Array),
      } satisfies RawResult;
    });

    router.patch('/api/contacts/:id/documents/:docId', 'location', (ctx) => {
      const d = docOf(ctx);
      if (!isAdmin(ctx) && d.created_by !== ctx.user?.id) throw bad('Nur wer die Datei hochgeladen hat, kann sie ändern');
      const patch: Record<string, unknown> = {};
      if (ctx.body?.name !== undefined) patch.name = cleanName(ctx.body.name);
      if (ctx.body?.private !== undefined) patch.private = ctx.body.private ? 1 : 0;
      if (Object.keys(patch).length) db.update('contact_documents', d.id, patch, ctx.locationId);
      return out(docOf(ctx));
    });

    router.delete('/api/contacts/:id/documents/:docId', 'location', (ctx) => {
      const d = docOf(ctx);
      if (d.private && !isAdmin(ctx) && d.created_by !== ctx.user?.id) throw bad('Nur wer die Datei hochgeladen hat, kann sie löschen');
      db.run('DELETE FROM contact_documents WHERE id = ?', d.id);
      return { ok: true };
    });
  },
};

