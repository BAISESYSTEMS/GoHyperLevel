import type { App, Module } from '../core/app.js';
import { HttpError, bad, clampLimit, notFound, str, type Ctx, type RawResult } from '../core/http.js';
import { id, now } from '../core/util.js';
import { actorOf, type Actor } from '../services/collab-actor.js';
import { getContact } from '../services/contacts.js';
import { blankFile } from '../services/office-blank.js';
import { blobToken, bridgeScript, editorAsset, editorPage, editorStatus, readBlobToken, sandboxMode } from '../services/office-bridge.js';
import { engineStatus } from '../services/office-engine.js';
import { KINDS, LIMITS, LOCK_RENEW_MS, LOCK_TTL_MS, OFFICE_KINDS, cleanName, isKind, kindOf, type OfficeKind } from '../services/office-model.js';
import { addVersion, assertWritable, blobsOf, getFile, getVersion, lockOf, maxFileBytes, quotaBytes, readVersion, removeBlobs, usedBytes, type FileRow } from '../services/office-store.js';
import { PUSH_KINDS } from './push.js';

/**
 * Office: documents, spreadsheets, presentations and PDFs per sub-account (docs/office.md) – files with immutable versions (each save is a
 * new version with its author: a person, the HyperLevel Agent on behalf of a person, or an API/MCP connection), optionally linked to a
 * contact, deal or project. The browser editors (optional upstream WebAssembly builds from PGHL_OFFICE_DIR) are served here too, the
 * edit lock and comments are in office-collab.ts, the agent's reading/editing through the engines in office-tools.ts.
 * Permission area `office`; every write lands in the audit log (afterWrite).
 */

const ext = (k: OfficeKind) => KINDS[k].ext;

/** A body with the file's bytes: raw (`application/octet-stream`, from the browser) or JSON `data` (base64 or a data: URL – API, MCP). */
export function bytesOf(ctx: Ctx): Buffer | null {
  if (ctx.rawBuffer) return ctx.rawBuffer;
  const raw = ctx.body?.data;
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw bad('data muss Base64-Text sein');
  const b64 = raw.replace(/^data:[\w/+.-]*;base64,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw bad('data ist kein gültiges Base64');
  return Buffer.from(b64, 'base64');
}

/** A parameter from the JSON body or – for raw uploads – the query string. */
export const param = (ctx: Ctx, key: string): unknown => (ctx.rawBuffer ? (ctx.query.get(key) ?? undefined) : ctx.body?.[key]);

/** Links to a contact, deal or project of the same sub-account (empty string = remove the link). */
function links(app: App, ctx: Ctx, get: (k: string) => unknown): Partial<Pick<FileRow, 'contact_id' | 'deal_id' | 'project_id'>> {
  const out: Partial<Pick<FileRow, 'contact_id' | 'deal_id' | 'project_id'>> = {};
  const read = (k: string) => {
    const v = get(k);
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    if (typeof v !== 'string' || v.length > 64) throw bad(`${k} ist ungültig`);
    return v;
  };
  const c = read('contact_id');
  if (c !== undefined) {
    if (c && !getContact(app, ctx.locationId, c)) throw bad('Kontakt nicht gefunden');
    out.contact_id = c;
  }
  const d = read('deal_id');
  if (d !== undefined) {
    if (d && !app.db.get('SELECT id FROM opportunities WHERE id = ? AND location_id = ?', d, ctx.locationId)) throw bad('Deal nicht gefunden');
    out.deal_id = d;
  }
  const p = read('project_id');
  if (p !== undefined) {
    let ok = false;
    try {
      ok = !p || !!app.db.get('SELECT id FROM pm_projects WHERE id = ? AND location_id = ?', p, ctx.locationId);
    } catch {
      ok = false;
    }
    if (!ok) throw bad('Projekt nicht gefunden');
    out.project_id = p;
  }
  return out;
}

const disposition = (name: string, inline: boolean) => `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

function fileBody(file: FileRow, buf: Buffer, inline: boolean): RawResult {
  return {
    __raw: true,
    status: 200,
    headers: {
      'content-type': KINDS[file.kind].mime,
      'content-length': String(buf.length),
      'content-disposition': disposition(file.name, inline),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      // a PDF opened inline must not run anything of ours
      'content-security-policy': "default-src 'none'; sandbox",
    },
    body: buf,
  };
}

/** Creates a file with its first version. */
export function createFile(app: App, ctx: Ctx, input: { kind: OfficeKind; name: unknown; bytes: Buffer; links: Partial<FileRow>; message: string }): FileRow {
  const actor = actorOf(app, ctx);
  const at = now();
  const file: FileRow = {
    id: id(),
    location_id: ctx.locationId,
    kind: input.kind,
    name: cleanName(input.name, input.kind),
    size: 0,
    version: 0,
    contact_id: input.links.contact_id ?? null,
    deal_id: input.links.deal_id ?? null,
    project_id: input.links.project_id ?? null,
    created_by: actor.id,
    created_by_name: actor.name,
    updated_by_name: actor.name,
    created_at: at,
    updated_at: at,
  };
  app.db.tx(() => {
    app.db.insert('office_files', file as unknown as Record<string, unknown>);
    addVersion(app, file, input.bytes, actor, input.message);
  });
  return file;
}

/** Saves bytes as a new version (lock and base version checked). */
export function saveVersion(app: App, ctx: Ctx, file: FileRow, buf: Buffer, o: { actor?: Actor; message: string; baseVersion?: number | null; force?: boolean; restoredFrom?: number | null }) {
  const actor = o.actor ?? actorOf(app, ctx);
  assertWritable(app, file, actor);
  if (o.baseVersion && o.baseVersion !== file.version && !o.force) {
    throw new HttpError(409, `Seit dem Öffnen gibt es eine neuere Version (${file.version}, von ${file.updated_by_name || 'jemandem'}). Trotzdem als neue Version speichern?`, { current_version: file.version, updated_by: file.updated_by_name });
  }
  let v;
  app.db.tx(() => {
    v = addVersion(app, file, buf, actor, o.message, o.restoredFrom ?? null);
  });
  return v!;
}

export const fileOut = (app: App, f: FileRow & Record<string, unknown>) => {
  const lock = lockOf(app, f.id);
  return { ...f, label: KINDS[f.kind]?.label ?? f.kind, lock: lock ? { user_id: lock.user_id, user_name: lock.user_name, expires_at: lock.expires_at } : null };
};

export const officeModule: Module = {
  name: 'office',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE office_files (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0,
        contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,
        deal_id TEXT REFERENCES opportunities(id) ON DELETE SET NULL,
        project_id TEXT REFERENCES pm_projects(id) ON DELETE SET NULL,
        created_by TEXT, created_by_name TEXT NOT NULL DEFAULT '', updated_by_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX office_files_location ON office_files(location_id, updated_at);
      CREATE INDEX office_files_contact ON office_files(contact_id);
      CREATE INDEX office_files_deal ON office_files(deal_id);
      CREATE INDEX office_files_project ON office_files(project_id);
      CREATE TABLE office_versions (
        id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES office_files(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, blob TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
        author_id TEXT, author_name TEXT NOT NULL DEFAULT '', author_kind TEXT NOT NULL DEFAULT 'user',
        message TEXT NOT NULL DEFAULT '', restored_from INTEGER, created_at TEXT NOT NULL,
        UNIQUE (file_id, version)
      );
      CREATE INDEX office_versions_location ON office_versions(location_id);
      -- A version is never changed: a save, a restore or an agent edit always adds a new one.
      CREATE TRIGGER office_versions_immutable BEFORE UPDATE ON office_versions BEGIN SELECT RAISE(ABORT, 'Versionen sind unveränderlich – jede Änderung ist eine neue Version'); END;
      CREATE TABLE office_locks (
        file_id TEXT PRIMARY KEY REFERENCES office_files(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE, user_name TEXT NOT NULL DEFAULT '',
        acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE office_comments (
        id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES office_files(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        version INTEGER, parent_id TEXT, body TEXT NOT NULL, mentions TEXT NOT NULL DEFAULT '[]',
        author_id TEXT, author_name TEXT NOT NULL DEFAULT '', via TEXT NOT NULL DEFAULT '',
        resolved_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX office_comments_file ON office_comments(file_id, created_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;

    // Comments and mentions reach people as push/bell notices (they can switch the kind off under Mein Konto).
    Object.assign(PUSH_KINDS, { office: { label: 'Kommentare und Erwähnungen in Office-Dateien', perm: 'office' } });

    // Raw uploads (the editor's save, the upload button) up to the file size limit; JSON with base64 `data` stays for API and MCP.
    const prevLimit = app.services.rawBodyLimit;
    app.services.rawBodyLimit = (method: string, path: string, req: any, cookies: Record<string, string>): number | undefined =>
      method === 'POST' && /^\/api\/office\/files(\/[A-Za-z0-9_-]{1,64}\/versions(\/convert)?)?$/.test(path) && String(req.headers['content-type'] ?? '').startsWith('application/octet-stream') && (cookies.pghl_session || req.headers.authorization)
        ? maxFileBytes() + 1024
        : prevLimit?.(method, path, req, cookies);
    // JSON with base64 grows by a third: allow it up to the file limit.
    app.services.bodyLimits = [
      ...(app.services.bodyLimits ?? []),
      { match: (m: string, p: string, req: any) => m === 'POST' && /^\/api\/office\/files(\/[A-Za-z0-9_-]{1,64}\/versions(\/convert)?)?$/.test(p) && String(req.headers['content-type'] ?? '').includes('json'), bytes: Math.ceil(maxFileBytes() * 1.4) + 64 * 1024 },
    ];

    // DSGVO: the files of a contact go with it (plain delete and erasure) – the rows cascade, the bytes are listed here.
    app.services.contactFiles = [
      ...(app.services.contactFiles ?? []),
      (_a: unknown, loc: string, cid: string) => blobsOf(app, db.all<{ id: string }>('SELECT id FROM office_files WHERE location_id = ? AND contact_id = ?', loc, cid).map((r) => r.id)),
    ];

    // --- status: what is installed, limits ---------------------------------------------------------------------------------
    router.get('/api/office/status', 'location', (ctx) => ({
      kinds: OFFICE_KINDS.map((k) => ({ kind: k, label: KINDS[k].label, one: KINDS[k].one, ext: ext(k) })),
      editors: editorStatus(),
      engines: engineStatus(),
      sandbox: sandboxMode(),
      lock_ttl_ms: LOCK_TTL_MS,
      lock_renew_ms: LOCK_RENEW_MS,
      limits: { max_bytes: maxFileBytes(), quota_bytes: quotaBytes(), used_bytes: usedBytes(app, ctx.locationId) },
    }));

    // --- files -------------------------------------------------------------------------------------------------------------
    router.get('/api/office/files', 'location', (ctx) => {
      const where = ['f.location_id = ?'];
      const args: unknown[] = [ctx.locationId];
      const kind = ctx.query.get('kind');
      if (kind) {
        if (!isKind(kind)) throw bad('Unbekannte Art (docx, xlsx, pptx, pdf)');
        where.push('f.kind = ?');
        args.push(kind);
      }
      const q = (ctx.query.get('q') ?? '').trim().slice(0, 100);
      if (q) {
        where.push("f.name LIKE ? ESCAPE '\\'");
        args.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      }
      for (const k of ['contact_id', 'deal_id', 'project_id']) {
        const v = ctx.query.get(k);
        if (v) {
          where.push(`f.${k} = ?`);
          args.push(v.slice(0, 64));
        }
      }
      const limit = clampLimit(ctx.query.get('limit'), 100, LIMITS.listMax);
      const rows = db.all<FileRow & Record<string, unknown>>(
        `SELECT f.*, TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS contact_name, o.name AS deal_name,
                (SELECT COUNT(*) FROM office_comments m WHERE m.file_id = f.id AND m.resolved_at IS NULL) AS open_comments
         FROM office_files f LEFT JOIN contacts c ON c.id = f.contact_id LEFT JOIN opportunities o ON o.id = f.deal_id
         WHERE ${where.join(' AND ')} ORDER BY f.updated_at DESC LIMIT ?`,
        ...(args as string[]),
        limit,
      );
      return rows.map((r) => fileOut(app, r));
    });

    /** Upload (raw body or JSON `data`) or a blank file of a kind (JSON `kind`, optional starting `text` / `rows`). */
    router.post('/api/office/files', 'location', (ctx) => {
      const buf = bytesOf(ctx);
      const name = param(ctx, 'name');
      const linked = links(app, ctx, (k) => param(ctx, k));
      if (name !== undefined && typeof name !== 'string') throw bad('name muss Text sein');
      if (typeof name === 'string' && name.length > 400) throw bad('Name ist zu lang');
      if (buf) {
        const claimed = param(ctx, 'kind');
        const kind = isKind(claimed) ? claimed : kindOf(param(ctx, 'mime'), name);
        if (!kind) throw bad('Nur Word- (.docx), Excel- (.xlsx), PowerPoint- (.pptx) oder PDF-Dateien');
        return fileOut(app, createFile(app, ctx, { kind, name, bytes: buf, links: linked, message: 'Hochgeladen' }) as FileRow & Record<string, unknown>);
      }
      const kind = param(ctx, 'kind');
      if (!isKind(kind)) throw bad('Art fehlt: docx, xlsx, pptx oder pdf');
      const text = ctx.body?.text;
      if (text !== undefined && (typeof text !== 'string' || text.length > 200_000)) throw bad('text muss Text sein (höchstens 200.000 Zeichen)');
      const rows = ctx.body?.rows;
      if (rows !== undefined && (!Array.isArray(rows) || !rows.every((r: unknown) => Array.isArray(r)))) throw bad('rows muss eine Liste von Zeilen sein');
      const bytes = blankFile(kind, { text, rows });
      return fileOut(app, createFile(app, ctx, { kind, name, bytes, links: linked, message: 'Neu angelegt' }) as FileRow & Record<string, unknown>);
    });

    router.get('/api/office/files/:id', 'location', (ctx) => {
      const f = getFile(app, ctx.locationId, ctx.params.id);
      const versions = db.all('SELECT id, version, size, author_id, author_name, author_kind, message, restored_from, created_at FROM office_versions WHERE file_id = ? ORDER BY version DESC LIMIT 500', f.id);
      const contact = f.contact_id ? db.get<{ first_name: string; last_name: string }>('SELECT first_name, last_name FROM contacts WHERE id = ?', f.contact_id) : undefined;
      const deal = f.deal_id ? db.get<{ name: string }>('SELECT name FROM opportunities WHERE id = ?', f.deal_id) : undefined;
      let project: { name: string } | undefined;
      try {
        project = f.project_id ? db.get<{ name: string }>('SELECT name FROM pm_projects WHERE id = ?', f.project_id) : undefined;
      } catch {
        project = undefined;
      }
      return {
        ...fileOut(app, f as FileRow & Record<string, unknown>),
        contact_name: contact ? `${contact.first_name ?? ''} ${contact.last_name ?? ''}`.trim() : null,
        deal_name: deal?.name ?? null,
        project_name: project?.name ?? null,
        open_comments: Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM office_comments WHERE file_id = ? AND resolved_at IS NULL', f.id)?.n ?? 0),
        versions,
        // the PDF editor fetches its file itself (?file=…) – without cookies, so through a short-lived signed link
        editor_file_url: f.kind === 'pdf' && f.version ? `/office/blob/${blobToken(app, ctx.locationId, f.id, f.version)}/${encodeURIComponent(f.name)}` : null,
      };
    });

    router.patch('/api/office/files/:id', 'location', (ctx) => {
      const f = getFile(app, ctx.locationId, ctx.params.id);
      const b = ctx.body ?? {};
      const patch: Record<string, unknown> = { ...links(app, ctx, (k) => b[k]) };
      if (b.name !== undefined) {
        if (typeof b.name !== 'string' || !b.name.trim()) throw bad('Name fehlt');
        if (b.name.length > 400) throw bad('Name ist zu lang');
        patch.name = cleanName(b.name, f.kind);
      }
      if (!Object.keys(patch).length) return fileOut(app, f as FileRow & Record<string, unknown>);
      patch.updated_at = now();
      db.update('office_files', f.id, patch, ctx.locationId);
      return fileOut(app, getFile(app, ctx.locationId, f.id) as FileRow & Record<string, unknown>);
    });

    router.delete('/api/office/files/:id', 'location', (ctx) => {
      const f = getFile(app, ctx.locationId, ctx.params.id);
      assertWritable(app, f, actorOf(app, ctx));
      const blobs = blobsOf(app, [f.id]);
      db.run('DELETE FROM office_files WHERE id = ? AND location_id = ?', f.id, ctx.locationId);
      removeBlobs(blobs);
      return { ok: true, id: f.id, name: f.name };
    });

    // --- content ------------------------------------------------------------------------------------------------------------
    const versionParam = (ctx: Ctx): number | null => {
      const v = ctx.query.get('version');
      if (!v) return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw bad('version muss eine Versionsnummer sein');
      return n;
    };
    /** Download (audit log: "download" is an export). */
    router.get('/api/office/files/:id/download', 'location', (ctx) => {
      const f = getFile(app, ctx.locationId, ctx.params.id);
      return fileBody(f, readVersion(app, getVersion(app, f, versionParam(ctx))), false);
    });
    /** The bytes for the editor bridge (not an export: the file stays in HyperLevel). */
    router.get('/api/office/files/:id/raw', 'location', (ctx) => {
      const f = getFile(app, ctx.locationId, ctx.params.id);
      return fileBody(f, readVersion(app, getVersion(app, f, versionParam(ctx))), true);
    });
    /** The signed link of the PDF editor (public: the editor runs without HyperLevel's cookies). */
    router.get('/office/blob/:token/:name', 'public', (ctx) => {
      const t = readBlobToken(app, ctx.params.token);
      if (!t) throw notFound('Link abgelaufen');
      const f = db.get<FileRow>('SELECT * FROM office_files WHERE id = ? AND location_id = ?', t.fileId, t.locationId);
      if (!f) throw notFound();
      const r = fileBody(f, readVersion(app, getVersion(app, f, t.version)), true);
      r.headers['access-control-allow-origin'] = '*';
      r.headers['cross-origin-resource-policy'] = 'cross-origin';
      return r;
    });

    // --- versions -----------------------------------------------------------------------------------------------------------
    router.get('/api/office/files/:id/versions', 'location', (ctx) => {
      const f = getFile(app, ctx.locationId, ctx.params.id);
      return db.all('SELECT id, version, size, sha256, author_id, author_name, author_kind, message, restored_from, created_at FROM office_versions WHERE file_id = ? ORDER BY version DESC LIMIT 1000', f.id);
    });

    /** A new version from the editor or an upload: raw body (`?message=&base_version=&force=1`) or JSON {data, message, base_version, force}. */
    router.post('/api/office/files/:id/versions', 'location', (ctx) => {
      const f = getFile(app, ctx.locationId, ctx.params.id);
      const buf = bytesOf(ctx);
      if (!buf) throw bad('Dateiinhalt fehlt');
      const message = str(param(ctx, 'message'), 'Notiz', { max: LIMITS.message }) || 'Gespeichert';
      const base = Number(param(ctx, 'base_version') ?? 0);
      const force = [true, 'true', '1', 1].includes(param(ctx, 'force') as never);
      const v = saveVersion(app, ctx, f, buf, { message, baseVersion: Number.isInteger(base) && base > 0 ? base : null, force });
      return { ...fileOut(app, f as FileRow & Record<string, unknown>), saved_version: v.version };
    });

    /** Restore = the old content as the next version (nothing is overwritten). */
    router.post('/api/office/files/:id/versions/:version/restore', 'location', (ctx) => {
      const f = getFile(app, ctx.locationId, ctx.params.id);
      const n = Number(ctx.params.version);
      if (!Number.isInteger(n) || n < 1) throw bad('Ungültige Versionsnummer');
      const old = getVersion(app, f, n);
      if (old.version === f.version) throw bad('Das ist schon die aktuelle Version');
      const v = saveVersion(app, ctx, f, readVersion(app, old), { message: `Version ${old.version} wiederhergestellt`, restoredFrom: old.version });
      return { ...fileOut(app, f as FileRow & Record<string, unknown>), saved_version: v.version };
    });

    // --- browser editors -----------------------------------------------------------------------------------------------------
    router.get('/office/bridge.js', 'public', () => bridgeScript());
    router.get('/office/app/:kind', 'user', (ctx) => editorPage(app, ctx, ctx.params.kind, maxFileBytes()));
    router.get('/office/app/:kind/:name', 'public', (ctx) => editorAsset(ctx, ctx.params.kind, ctx.params.name));
  },
};
