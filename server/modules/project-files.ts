import { createHash } from 'node:crypto';
import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import type { Tool } from './mcp.js';
import { writeAudit } from './security.js';

/**
 * Project files (docs/ai-tools.md#project-files): a per sub-account store for arbitrary files of a project – the instructions and
 * knowledge files of a claude.ai project, the relevant files of a repository from Claude Code – text and binary. One row per relative
 * path (upsert), the bytes in the row (BLOB, so backups, the tenant export and deleting a sub-account take them along). Downloads are
 * always attachments with nosniff and a sandbox CSP: a stored HTML or SVG file never runs on the app's origin.
 *
 * Limits: 10 MB per file, 25 MB and 200 files per batch, PGHL_PROJECT_FILES_MB per sub-account (default 1024, 0 = no cap of its own)
 * and, in the hosted cloud, the plan's media storage (the files count in that meter).
 */

const MB = 1024 * 1024;
export const FILE_MAX = 10 * MB;
export const BATCH_MAX_BYTES = 25 * MB;
export const BATCH_MAX_FILES = 200;
/** Text content up to this size comes back inline from GET /api/project-files/:id. */
const INLINE_MAX = 1 * MB;

/** The cap of a sub-account's project files in bytes (null = none). */
export function projectFilesCap(): number | null {
  const raw = process.env.PGHL_PROJECT_FILES_MB;
  const mb = raw === undefined || raw.trim() === '' ? 1024 : Number(raw);
  if (!Number.isFinite(mb) || mb < 0) return 1024 * MB;
  return mb === 0 ? null : Math.round(mb * MB);
}

/**
 * A relative, normalised path: forward slashes, no leading slash or "./", no empty, "." or ".." segment, no control characters,
 * at most 500 characters. Throws a 400 with a German message otherwise.
 */
export function cleanPath(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw bad('path fehlt');
  let p = v.normalize('NFC').trim().replace(/\\/g, '/');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) throw bad('path: Steuerzeichen sind nicht erlaubt');
  if (/^[A-Za-z]:\//.test(p)) throw bad('path: bitte einen relativen Pfad angeben (ohne Laufwerk)');
  p = p.replace(/^(\.\/|\/)+/, '').replace(/\/{2,}/g, '/');
  const parts = p.split('/');
  if (!p || p.endsWith('/') || parts.some((s) => s === '' || s === '.' || s === '..')) throw bad(`path „${v.slice(0, 80)}“ ist ungültig (relativ, ohne „..“, nicht leer)`);
  if (p.length > 500) throw bad('path ist zu lang (höchstens 500 Zeichen)');
  return p;
}

const EXT_MIME: Record<string, string> = {
  md: 'text/markdown', markdown: 'text/markdown', mdx: 'text/markdown', txt: 'text/plain', log: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', jsonl: 'application/x-ndjson', yaml: 'application/yaml', yml: 'application/yaml', toml: 'application/toml', xml: 'application/xml',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', svg: 'image/svg+xml',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
/** Source code and config files without a registered type of their own are plain text. */
const CODE_EXT = /^(ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|sql|graphql|gql|vue|svelte|astro|ini|cfg|conf|env|lock|gitignore|dockerignore|editorconfig|prisma|proto|tf|r|scala|lua|pl|ex|exs|dart)$/;
const TEXT_MIME = /^(text\/|application\/(json|x-ndjson|ld\+json|xml|yaml|toml|javascript|sql|graphql)$|image\/svg\+xml$)/;

export function guessMime(path: string, text: boolean): string {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : base;
  if (EXT_MIME[ext]) return EXT_MIME[ext];
  if (CODE_EXT.test(ext) || /^(dockerfile|makefile|license|readme|claude\.md)$/i.test(base)) return 'text/plain';
  return text ? 'text/plain' : 'application/octet-stream';
}

const cleanMime = (v: unknown): string | null => {
  if (v === undefined || v === null || v === '') return null;
  const m = String(v).split(';')[0].trim().toLowerCase();
  if (m.length > 100 || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(m)) throw bad(`mime „${String(v).slice(0, 60)}“ ist ungültig`);
  return m;
};

const utf8 = new TextDecoder('utf-8', { fatal: true });
/** Readable as text: a text type, valid UTF-8 and no NUL byte. */
export function isText(mime: string, buf: Uint8Array): boolean {
  if (!TEXT_MIME.test(mime) || buf.includes(0)) return false;
  try {
    utf8.decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** Never hand a browser something it would render or run: markup and scripts go out as plain bytes. */
const ACTIVE = /html|svg|xml|javascript|ecmascript|xhtml/;
const servedType = (mime: string) => (ACTIVE.test(mime) ? 'application/octet-stream' : mime);
const disposition = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1) || 'datei';
  const ascii = name.replace(/[^\w.-]+/g, '_').slice(0, 150) || 'datei';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).slice(0, 600)}`;
};

interface Incoming {
  path: string;
  mime: string;
  buf: Buffer;
  sha256: string;
}

/** Checks a batch completely before anything is written: shape, paths, sizes, duplicates. */
function parseBatch(list: unknown): Incoming[] {
  if (!Array.isArray(list) || !list.length) throw bad('files: Liste mit mindestens einer Datei erwartet');
  if (list.length > BATCH_MAX_FILES) throw new HttpError(413, `Höchstens ${BATCH_MAX_FILES} Dateien je Aufruf – bitte aufteilen`);
  const seen = new Set<string>();
  let total = 0;
  return list.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad(`files[${i}]: Objekt {path, content} oder {path, data} erwartet`);
    const f = raw as Record<string, unknown>;
    const path = cleanPath(f.path);
    if (seen.has(path)) throw bad(`files: ${path} kommt doppelt vor`);
    seen.add(path);
    const hasContent = typeof f.content === 'string';
    const hasData = typeof f.data === 'string';
    if (hasContent === hasData) throw bad(`${path}: genau eines von content (Text) oder data (Base64) angeben`);
    let buf: Buffer;
    if (hasContent) buf = Buffer.from(f.content as string, 'utf8');
    else {
      const b64 = (f.data as string).replace(/^data:[^,]*;base64,/, '').replace(/\s+/g, '');
      if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64)) throw bad(`${path}: data ist kein gültiges Base64`);
      buf = Buffer.from(b64, 'base64');
    }
    if (buf.length > FILE_MAX) throw new HttpError(413, `${path}: Datei größer als ${FILE_MAX / MB} MB`);
    total += buf.length;
    if (total > BATCH_MAX_BYTES) throw new HttpError(413, `Mehr als ${BATCH_MAX_BYTES / MB} MB in einem Aufruf – bitte aufteilen`);
    const mime = cleanMime(f.mime) ?? guessMime(path, hasContent);
    return { path, mime, buf, sha256: createHash('sha256').update(buf).digest('hex') };
  });
}

const META = 'id, location_id, path, mime, size, sha256, source, created_at, updated_at';

/** Stores a batch (upsert by path). Unchanged files (same bytes and type) are left alone. */
export function saveProjectFiles(app: App, locationId: string, list: unknown, source: unknown) {
  const { db } = app;
  const files = parseBatch(list);
  const src = str(source, 'source', { max: 60 }) || 'upload';
  const current = new Map<string, { id: string; size: number; sha256: string; mime: string }>();
  for (const f of files) {
    const row = db.get<{ id: string; size: number; sha256: string; mime: string }>('SELECT id, size, sha256, mime FROM project_files WHERE location_id = ? AND path = ?', locationId, f.path);
    if (row) current.set(f.path, row);
  }
  // Only what grows counts against the caps.
  const growth = files.reduce((n, f) => n + f.buf.length - (current.get(f.path)?.size ?? 0), 0);
  if (growth > 0) {
    const cap = projectFilesCap();
    const used = Number(db.get<{ n: number }>('SELECT COALESCE(SUM(size), 0) AS n FROM project_files WHERE location_id = ?', locationId)?.n ?? 0);
    if (cap !== null && used + growth > cap) throw new HttpError(413, `Der Speicher für Projektdateien dieses Sub-Accounts ist voll (${Math.round(cap / MB)} MB) – alte Dateien löschen oder das Limit erhöhen (PGHL_PROJECT_FILES_MB)`);
    app.services.storageGate?.(locationId, growth);
  }
  const out: { id: string; path: string; size: number; sha256: string; status: 'created' | 'updated' | 'unchanged' }[] = [];
  const at = now();
  db.tx(() => {
    for (const f of files) {
      const cur = current.get(f.path);
      if (cur && cur.sha256 === f.sha256 && cur.mime === f.mime) {
        out.push({ id: cur.id, path: f.path, size: f.buf.length, sha256: f.sha256, status: 'unchanged' });
      } else if (cur) {
        db.run('UPDATE project_files SET mime = ?, size = ?, sha256 = ?, source = ?, data = ?, updated_at = ? WHERE id = ?', f.mime, f.buf.length, f.sha256, src, f.buf, at, cur.id);
        out.push({ id: cur.id, path: f.path, size: f.buf.length, sha256: f.sha256, status: 'updated' });
      } else {
        const fid = id();
        db.run('INSERT INTO project_files (id, location_id, path, mime, size, sha256, source, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', fid, locationId, f.path, f.mime, f.buf.length, f.sha256, src, f.buf, at, at);
        out.push({ id: fid, path: f.path, size: f.buf.length, sha256: f.sha256, status: 'created' });
      }
    }
  });
  const count = (s: string) => out.filter((f) => f.status === s).length;
  return { name: `${out.length} Datei(en)`, created: count('created'), updated: count('updated'), unchanged: count('unchanged'), files: out };
}

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects); mit einem Sub-Account-Zugang weglassen' } };

const TOOLS: Tool[] = [
  {
    name: 'ghl_upload_files',
    title: 'Projektdateien hochladen',
    description: `Legt Dateien eines Projekts ab oder ersetzt sie (gleicher path = gleiche Datei; unveränderte Dateien bleiben stehen): Anweisungen und Wissensdateien eines claude.ai-Projekts, die wichtigen Dateien eines Repos aus Claude Code, Notizen. files: [{path: relativer Pfad wie „docs/plan.md“, content: Text (UTF-8)} oder {path, data: Base64 für Binärdateien}, mime?]. source z. B. „claude-project“ oder „claude-code“. Grenzen: ${FILE_MAX / MB} MB je Datei, ${BATCH_MAX_FILES} Dateien und ${BATCH_MAX_BYTES / MB} MB je Aufruf; ein MCP-Aufruf darf insgesamt etwa 12 MB groß sein – größere Mengen auf mehrere Aufrufe verteilen.`,
    inputSchema: {
      type: 'object',
      properties: {
        ...LOC,
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, data: { type: 'string' }, mime: { type: 'string' } }, required: ['path'] } },
        source: { type: 'string', description: 'Herkunft, z. B. claude-project, claude-code' },
      },
      required: ['files'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (call, a) => call.api('POST', '/api/project-files', { location: a.location_id, body: { files: a.files, source: a.source } }),
  },
  {
    name: 'ghl_list_files',
    title: 'Projektdateien auflisten',
    description: 'Die abgelegten Dateien eines Projekts (Pfad, Typ, Größe, SHA-256, Herkunft, Datum), optional nur unter einem Pfad-Präfix (prefix, z. B. „src/“).',
    inputSchema: { type: 'object', properties: { ...LOC, prefix: { type: 'string' } }, required: [] },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/project-files${a.prefix ? `?${new URLSearchParams({ prefix: String(a.prefix) })}` : ''}`, { location: a.location_id }),
  },
  {
    name: 'ghl_read_file',
    title: 'Projektdatei lesen',
    description: 'Eine Projektdatei (id aus ghl_list_files): Metadaten und – bei Textdateien bis 1 MB – der Inhalt. Binärdateien gibt es nur als Download in der App.',
    inputSchema: { type: 'object', properties: { ...LOC, id: { type: 'string' } }, required: ['id'] },
    annotations: { readOnlyHint: true, openWorldHint: false },
    untrusted: true,
    run: (call, a) => call.api('GET', `/api/project-files/${encodeURIComponent(a.id)}`, { location: a.location_id }),
  },
  {
    name: 'ghl_delete_file',
    title: 'Projektdatei löschen',
    description: 'Löscht eine Projektdatei endgültig (id aus ghl_list_files).',
    inputSchema: { type: 'object', properties: { ...LOC, id: { type: 'string' } }, required: ['id'] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (call, a) => call.api('DELETE', `/api/project-files/${encodeURIComponent(a.id)}`, { location: a.location_id }),
  },
];

export const projectFilesModule: Module = {
  name: 'project-files',
  migrations: [
    [
      '001-init',
      `CREATE TABLE project_files (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 500), mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '', data BLOB NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (location_id, path)
      );
      CREATE INDEX project_files_size ON project_files(location_id, size);`,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    app.services.saveProjectFiles = (locationId: string, files: unknown, source?: string) => saveProjectFiles(app, locationId, files, source);
    // A full batch is 25 MB of files; as JSON with Base64 it grows by a third.
    app.services.bodyLimits = [...(app.services.bodyLimits ?? []), { match: (m: string, p: string) => m === 'POST' && p === '/api/project-files', bytes: Math.ceil(BATCH_MAX_BYTES * 1.4) + MB }];

    const own = (ctx: Ctx) => {
      const row = db.get(`SELECT ${META} FROM project_files WHERE id = ? AND location_id = ?`, ctx.params.id, ctx.locationId);
      if (!row) throw notFound('Datei nicht gefunden');
      return row;
    };

    router.post('/api/project-files', 'location', (ctx) => saveProjectFiles(app, ctx.locationId, ctx.body?.files, ctx.body?.source));
    router.get('/api/project-files', 'location', (ctx) => {
      const prefix = (ctx.query.get('prefix') ?? '').slice(0, 500);
      const esc = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
      const files = db.all(`SELECT ${META} FROM project_files WHERE location_id = ? AND path LIKE ? ESCAPE '\\' ORDER BY path LIMIT 5000`, ctx.locationId, `${esc}%`);
      const total = db.get<{ n: number; bytes: number }>('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM project_files WHERE location_id = ?', ctx.locationId);
      return { files, total: Number(total?.n ?? 0), bytes: Number(total?.bytes ?? 0), limit_bytes: projectFilesCap() };
    });
    router.get('/api/project-files/:id', 'location', (ctx) => {
      const row = own(ctx);
      const data = db.get<{ data: Uint8Array }>('SELECT data FROM project_files WHERE id = ?', row.id)!.data;
      const text = isText(row.mime, data);
      return { ...row, text, content: text && data.length <= INLINE_MAX ? Buffer.from(data).toString('utf8') : null };
    });
    router.get('/api/project-files/:id/raw', 'location', (ctx) => {
      const row = own(ctx);
      const data = db.get<{ data: Uint8Array }>('SELECT data FROM project_files WHERE id = ?', row.id)!.data;
      writeAudit(app, { ctx, action: 'export:project-files', route: 'GET /api/project-files/:id/raw', entityId: row.id, summary: String(row.path).slice(0, 200) });
      return {
        __raw: true,
        status: 200,
        headers: {
          'content-type': servedType(row.mime),
          'content-disposition': disposition(row.path),
          'x-content-type-options': 'nosniff',
          'content-security-policy': "sandbox; default-src 'none'",
          'cache-control': 'private, no-store',
        },
        body: Buffer.from(data),
      };
    });
    router.delete('/api/project-files/:id', 'location', (ctx) => {
      const row = own(ctx);
      db.run('DELETE FROM project_files WHERE id = ? AND location_id = ?', row.id, ctx.locationId);
      return { ok: true, id: row.id, name: row.path };
    });
  },
};
