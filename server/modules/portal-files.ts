import type { Module } from '../core/app.js';
import { contentMatches } from '../core/files.js';
import { bad, HttpError, notFound, redirect, type Ctx, type RawResult } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { id, now, safeEqual, sha256 } from '../core/util.js';
import { getContact, logActivity } from '../services/contacts.js';
import { portalUrl } from '../services/courses.js';
import { mayUseArea, membersWhere, notifyMember } from '../services/member-notify.js';
import { resolve as accessOf, scopeClause } from '../services/record-access.js';
import { cleanName, DOC_MAX, DOC_TYPES, docsCap } from './contact-documents.js';
import type { Tool } from './mcp.js';
import type { Member, Portal } from './portal.js';

/**
 * Files in the customer portal (HighLevel parity, docs/sales.md#files-in-the-customer-portal): the team shares a document of a
 * contact ("Im Portal freigeben") and that contact sees it under /portal/<p>/documents and downloads it; if the sub-account allows it,
 * the customer uploads files back – they land on the contact as ordinary documents, with an activity, an event
 * (`portal.file_uploaded`) and a notification to the contact's owner (or the admins).
 *
 * The bytes stay in contact-documents (BLOB, never a public URL); this module only keeps which document is shared with whom
 * (`portal_files`) and the upload rules per sub-account (`portal_file_settings`). Isolation: every portal lookup is by the member's
 * own contact id and sub-account – a member never reaches another contact's file, a "nur für mich" file is never shared.
 * Downloads always go out as attachment with nosniff and a sandbox CSP; uploads accept only the contact-documents types (no HTML,
 * no SVG), the type comes from the file name and the content must match it (magic bytes; text without markup).
 */

const MB = 1024 * 1024;
const PER_CONTACT = 200;
const UPLOADS_PER_DAY = 20;
const CATEGORIES: Record<string, (mime: string) => boolean> = {
  images: (m) => m.startsWith('image/'),
  pdf: (m) => m === 'application/pdf',
  office: (m) => /^application\/(msword|vnd\.)/.test(m),
  text: (m) => m === 'text/plain' || m === 'text/csv',
};
const CATEGORY_LABEL: Record<string, string> = { images: 'Bilder', pdf: 'PDF', office: 'Office-Dateien', text: 'Text/CSV' };
const ACCEPT: Record<string, string> = { images: 'image/png,image/jpeg,image/gif,image/webp,.heic', pdf: '.pdf', office: '.doc,.docx,.xls,.xlsx,.pptx,.odt,.ods', text: '.txt,.csv' };
const BY_EXT: Record<string, string> = Object.fromEntries([...Object.entries(DOC_TYPES).map(([m, e]) => [e, m]), ['jpeg', 'image/jpeg']]);

export interface PortalFileSettings {
  uploads: boolean;
  max_mb: number;
  quota_mb: number;
  types: string[];
  notify: boolean;
}
const DEFAULTS: PortalFileSettings = { uploads: false, max_mb: 8, quota_mb: 50, types: ['images', 'pdf', 'office', 'text'], notify: true };

export function cleanSettings(v: any, cur: PortalFileSettings = DEFAULTS): PortalFileSettings {
  const num = (x: unknown, min: number, max: number, d: number) => {
    const n = Math.round(Number(x));
    return x === undefined || x === null || x === '' || !Number.isFinite(n) ? d : Math.min(max, Math.max(min, n));
  };
  const types = Array.isArray(v?.types) ? [...new Set(v.types.map(String).filter((t: string) => t in CATEGORIES))] : cur.types;
  return {
    uploads: v?.uploads === undefined ? cur.uploads : !!v.uploads,
    max_mb: num(v?.max_mb, 1, DOC_MAX / MB, cur.max_mb),
    quota_mb: num(v?.quota_mb, 1, 2048, cur.quota_mb),
    types: types.length ? (types as string[]) : cur.types,
    notify: v?.notify === undefined ? cur.notify : !!v.notify,
  };
}

/** The file part(s) and text fields of a multipart/form-data body (one small form: a token and a file). */
export function parseMultipart(buf: Buffer, contentType: string | undefined): { fields: Record<string, string>; files: { field: string; filename: string; data: Buffer }[] } {
  const m = /boundary=(?:"([^"]{1,70})"|([^;\s]{1,70}))/i.exec(String(contentType ?? ''));
  if (!m || !/multipart\/form-data/i.test(String(contentType))) throw bad('Bitte das Formular verwenden');
  const delim = Buffer.from(`--${m[1] ?? m[2]}`);
  const fields: Record<string, string> = {};
  const files: { field: string; filename: string; data: Buffer }[] = [];
  let pos = buf.indexOf(delim);
  let parts = 0;
  while (pos !== -1 && parts++ < 10) {
    const start = pos + delim.length;
    if (buf.subarray(start, start + 2).toString() === '--') break;
    const next = buf.indexOf(delim, start);
    if (next === -1) break;
    const part = buf.subarray(start + 2, next - 2); // skip CRLF after the delimiter and before the next one
    const sep = part.indexOf('\r\n\r\n');
    if (sep !== -1) {
      const head = part.subarray(0, sep).toString('utf8');
      const data = part.subarray(sep + 4);
      const disp = /content-disposition:\s*form-data;([^\r\n]*)/i.exec(head)?.[1] ?? '';
      const name = /\bname="([^"]*)"/i.exec(disp)?.[1] ?? '';
      const filename = /\bfilename="([^"]*)"/i.exec(disp)?.[1];
      if (filename !== undefined) files.push({ field: name, filename, data });
      else if (name) fields[name] = data.toString('utf8').slice(0, 2000);
    }
    pos = next;
  }
  return { fields, files };
}

const ICON = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
const HEAD = `<style>
.pf-link{color:var(--text);text-decoration:none;font-weight:600;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}.pf-link:hover{color:var(--brand)}
.pf-dash{margin-top:34px}.pf-dash h2,.pf-h{display:flex;align-items:center;gap:8px}
.pf-row{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.pf-row .n{font-weight:600;overflow-wrap:anywhere}.pf-st{font-size:13px;color:var(--muted)}
.pf-up{margin-top:28px}.pf-up form{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:10px}.pf-up input[type=file]{font:inherit;max-width:100%}
.pf-err{background:rgba(220,38,38,.1);color:#dc2626;padding:12px 16px;border-radius:12px;margin-bottom:20px;font-weight:600}
@media (max-width:600px){.pf-link span{display:none}}
</style>`;
/** Fixed messages after an upload (the redirect carries a code, never text). */
const ERRORS: Record<string, string> = {
  off: 'Hochladen ist hier nicht möglich.',
  empty: 'Bitte eine Datei auswählen.',
  type: 'Dieser Dateityp ist nicht erlaubt.',
  content: 'Der Inhalt passt nicht zum Dateityp.',
  size: 'Die Datei ist zu groß.',
  quota: 'Dein Speicherplatz für Uploads ist voll.',
  count: 'Für heute sind genug Dateien hochgeladen – bitte morgen weitermachen.',
  form: 'Die Seite war zu lange offen. Bitte neu laden und noch einmal senden.',
};

type Kit = {
  resolve: (key: string) => Portal | undefined;
  memberOf: (ctx: Ctx, p: Portal) => Member | undefined;
  page: (p: Portal, o: { title: string; body: string; member?: Member; status?: number; head?: string }) => RawResult;
  loginPage: (p: Portal, o?: { error?: string; status?: number; next?: string }) => RawResult;
  notFoundPage: (p: Portal, m?: Member) => RawResult;
  unknownPortal: () => RawResult;
  sameOrigin: (ctx: Ctx) => boolean;
};

const TOOLS: Tool[] = [
  {
    name: 'ghl_portal_files',
    title: 'Im Kundenportal freigegebene Dateien eines Kontakts',
    description: 'Welche Dokumente eines Kontakts im Kundenportal freigegeben sind und welche der Kunde selbst hochgeladen hat (Name, Typ, Größe, Quelle team|customer, Downloads) – ohne Inhalt. Dazu die Portal-Adresse und ob Uploads erlaubt sind.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, contact_id: { type: 'string' } }, required: ['contact_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/contacts/${encodeURIComponent(String(a.contact_id))}/portal-files`, { location: a.location_id }),
  },
  {
    name: 'ghl_portal_file_share',
    title: 'Dokument im Kundenportal freigeben oder zurückziehen',
    description: 'Gibt ein Dokument des Kontakts (aus ghl_contact_documents) im Kundenportal frei (shared: true) oder nimmt die Freigabe zurück (false). Nur dieser Kontakt sieht die Datei nach dem Login im Portal. „Nur für mich“-Dateien lassen sich nicht freigeben.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, contact_id: { type: 'string' }, document_id: { type: 'string' }, shared: { type: 'boolean' } }, required: ['contact_id', 'document_id', 'shared'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (call, a) => call.api('PUT', `/api/contacts/${encodeURIComponent(String(a.contact_id))}/documents/${encodeURIComponent(String(a.document_id))}/portal`, { location: a.location_id, body: { shared: a.shared !== false } }),
  },
];

export const portalFilesModule: Module = {
  name: 'portal-files',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE portal_files (
        doc_id TEXT PRIMARY KEY REFERENCES contact_documents(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        source TEXT NOT NULL DEFAULT 'team', shared INTEGER NOT NULL DEFAULT 1, shared_by TEXT,
        created_at TEXT NOT NULL, shared_at TEXT, downloads INTEGER NOT NULL DEFAULT 0, last_download_at TEXT
      );
      CREATE INDEX portal_files_contact ON portal_files(location_id, contact_id, shared);
      CREATE TABLE portal_file_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        settings TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    const settingsOf = (loc: string): PortalFileSettings => {
      const raw = db.get<{ settings: string }>('SELECT settings FROM portal_file_settings WHERE location_id = ?', loc)?.settings;
      try {
        return cleanSettings(raw ? JSON.parse(raw) : {});
      } catch {
        return { ...DEFAULTS };
      }
    };
    const kit = (): Kit => {
      const k = app.services.portalKit;
      if (!k) throw new HttpError(501, 'Mitgliederbereich nicht verfügbar');
      return k;
    };
    const csrf = (m: Member) => sha256(`${app.config.secret}:portal-files:${m.sessionHash}`).slice(0, 32);
    const base = (p: Portal) => `${p.base}/documents`;
    const size = (n: number) => (n < MB ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / MB).toFixed(1)} MB`);
    const day = (iso: string, tz: string) => {
      try {
        return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: tz }).format(new Date(iso));
      } catch {
        return iso.slice(0, 10);
      }
    };

    /** The member's own files: always by sub-account AND contact id, never a "nur für mich" file. */
    const filesOf = (loc: string, contactId: string) =>
      db.all<any>(
        `SELECT d.id, d.name, d.mime, d.size, d.created_at, f.source, f.shared_at, f.downloads, f.last_download_at
         FROM portal_files f JOIN contact_documents d ON d.id = f.doc_id
         WHERE f.location_id = ? AND f.contact_id = ? AND f.shared = 1 AND d.location_id = f.location_id AND d.contact_id = f.contact_id AND d.private = 0
         ORDER BY COALESCE(f.shared_at, f.created_at) DESC LIMIT 300`,
        loc,
        contactId,
      );
    const hasShared = (loc: string, cid: string) =>
      !!db.get(`SELECT 1 AS x FROM portal_files f JOIN contact_documents d ON d.id = f.doc_id WHERE f.location_id = ? AND f.contact_id = ? AND f.shared = 1 AND f.source = 'team' AND d.private = 0 LIMIT 1`, loc, cid);

    // --- the team side -------------------------------------------------------------------------------------------------
    const isAdmin = (ctx: Ctx) => ctx.user?.role === 'admin' || (!ctx.user && !!ctx.viaApiKey);
    /** The contact, if the person may see it (sub-account + record access) – same rule as its documents. */
    const contactOf = (ctx: Ctx, contactId: string) => {
      const scope = scopeClause(accessOf(app, ctx), 'contacts', 'c');
      const c = db.get<{ id: string }>(`SELECT c.id FROM contacts c WHERE c.id = ? AND c.location_id = ?${scope ? ` AND ${scope.sql}` : ''}`, contactId, ctx.locationId, ...((scope?.params ?? []) as string[]));
      if (!c) throw notFound('Kontakt nicht gefunden');
      return c;
    };
    const teamList = (ctx: Ctx, contactId: string) => {
      contactOf(ctx, contactId);
      const files = db
        .all<any>(
          `SELECT d.id AS doc_id, d.name, d.mime, d.size, d.note_id, f.source, f.shared, f.shared_at, f.created_at, f.downloads, f.last_download_at, u.name AS shared_by_name
           FROM portal_files f JOIN contact_documents d ON d.id = f.doc_id LEFT JOIN users u ON u.id = f.shared_by
           WHERE f.location_id = ? AND f.contact_id = ? AND d.private = 0 ORDER BY COALESCE(f.shared_at, f.created_at) DESC`,
          ctx.locationId,
          contactId,
        )
        .map((r) => ({ ...r, shared: !!r.shared, url: `/api/contacts/${encodeURIComponent(contactId)}/documents/${r.doc_id}` }));
      const s = settingsOf(ctx.locationId);
      return { files, portal_url: `${portalUrl(app, ctx.locationId)}/documents`, uploads: s.uploads };
    };

    router.get('/api/contacts/:id/portal-files', 'location', (ctx) => teamList(ctx, ctx.params.id));

    router.put('/api/contacts/:id/documents/:docId/portal', 'location', (ctx) => {
      const c = contactOf(ctx, ctx.params.id);
      const d = db.get<any>('SELECT id, private, created_by FROM contact_documents WHERE id = ? AND contact_id = ? AND location_id = ?', ctx.params.docId, c.id, ctx.locationId);
      // A "nur für mich" file of someone else does not exist for this person; one's own private file cannot be shared.
      if (!d || (d.private && !isAdmin(ctx) && d.created_by !== ctx.user?.id)) throw notFound('Datei nicht gefunden');
      const shared = ctx.body?.shared !== false && ctx.body?.shared !== 0 && ctx.body?.shared !== '0';
      if (shared && d.private) throw bad('„Nur für mich“-Dateien lassen sich nicht im Portal freigeben');
      const row = db.get<any>('SELECT * FROM portal_files WHERE doc_id = ?', d.id);
      if (shared) {
        if (row) db.run('UPDATE portal_files SET shared = 1, shared_at = ?, shared_by = ? WHERE doc_id = ?', now(), ctx.user?.id ?? null, d.id);
        else db.insert('portal_files', { doc_id: d.id, location_id: ctx.locationId, contact_id: c.id, source: 'team', shared: 1, shared_by: ctx.user?.id ?? null, created_at: now(), shared_at: now() });
        if (!row?.shared) logActivity(app, ctx.locationId, c.id, 'portal.file_shared', 'Datei im Kundenportal freigegeben', { document_id: d.id });
      } else if (row) {
        db.run('UPDATE portal_files SET shared = 0 WHERE doc_id = ?', d.id);
      }
      return teamList(ctx, c.id);
    });

    router.get('/api/portal-files/settings', 'location', (ctx) => ({ ...settingsOf(ctx.locationId), max_file_mb: DOC_MAX / MB, categories: Object.keys(CATEGORIES), portal_url: `${portalUrl(app, ctx.locationId)}/documents` }));
    router.put('/api/portal-files/settings', 'location', (ctx) => {
      if (!isAdmin(ctx) && !(ctx.user && mayUseArea(ctx.user, ctx.locationId, 'settings'))) throw new HttpError(403, 'Nur Admins und Personen mit Zugriff auf die Einstellungen');
      const next = cleanSettings(ctx.body ?? {}, settingsOf(ctx.locationId));
      db.run('INSERT INTO portal_file_settings (location_id, settings, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at', ctx.locationId, JSON.stringify(next), now());
      return { ...next, max_file_mb: DOC_MAX / MB, categories: Object.keys(CATEGORIES), portal_url: `${portalUrl(app, ctx.locationId)}/documents` };
    });

    // --- the portal side -----------------------------------------------------------------------------------------------
    app.services.portalHead = [...(app.services.portalHead ?? []), () => HEAD];
    app.services.portalHeader = [
      ...(app.services.portalHeader ?? []),
      (p: Portal, m: Member) => (hasShared(p.locationId, m.contact.id) || settingsOf(p.locationId).uploads ? `<a class="pf-link" href="${base(p)}" aria-label="Meine Dateien">${ICON}<span>Meine Dateien</span></a>` : ''),
    ];
    app.services.portalDashboard = [
      ...(app.services.portalDashboard ?? []),
      (p: Portal, m: Member) => {
        const fresh = filesOf(p.locationId, m.contact.id).filter((f) => f.source === 'team' && !f.downloads);
        if (!fresh.length) return '';
        const list = fresh.slice(0, 3).map((f) => `<div class="pf-row"><div><div class="n">${escapeHtml(f.name)}</div><div class="pf-st">${size(f.size)}</div></div><a class="btn ghost" href="${base(p)}/${encodeURIComponent(f.id)}">Herunterladen</a></div>`).join('');
        return `<section class="pf-dash"><h2>${ICON} Neue Dateien für dich (${fresh.length})</h2>${list}<a href="${base(p)}">Alle Dateien</a></section>`;
      },
    ];
    // A contact the team shared a file with may log in to the portal.
    app.services.portalMemberCheck = [...(app.services.portalMemberCheck ?? []), (loc: string, cid: string) => hasShared(loc, cid)];
    app.services.portalNextPrefixes = [...(app.services.portalNextPrefixes ?? []), 'documents'];

    // The upload form posts multipart bytes: only on this route and only with a member cookie.
    const prevLimit = app.services.rawBodyLimit;
    app.services.rawBodyLimit = (method: string, path: string, req: any, cookies: Record<string, string>): number | undefined => {
      if (method === 'POST' && /^\/portal\/[^/]+\/documents$/.test(path) && Object.keys(cookies).some((k) => k.startsWith('pm_'))) return DOC_MAX + 64 * 1024;
      return prevLimit?.(method, path, req, cookies);
    };

    const withMember = (ctx: Ctx, fn: (k: Kit, p: Portal, m: Member) => RawResult) => {
      const k = kit();
      const p = k.resolve(ctx.params.p);
      if (!p) return k.unknownPortal();
      const m = k.memberOf(ctx, p);
      if (!m) return ctx.method === 'GET' ? k.loginPage(p, { status: 401, next: ctx.path }) : redirect(p.base, 303);
      return fn(k, p, m);
    };

    router.get('/portal/:p/documents', 'public', (ctx) =>
      withMember(ctx, (k, p, m) => {
        const tz = p.loc.timezone || 'Europe/Berlin';
        const s = settingsOf(p.locationId);
        const files = filesOf(p.locationId, m.contact.id);
        const row = (f: any) =>
          `<div class="pf-row"><div><div class="n">${escapeHtml(f.name)}</div><div class="pf-st">${size(f.size)} · ${escapeHtml(day(f.shared_at || f.created_at, tz))}</div></div><a class="btn ghost" href="${base(p)}/${encodeURIComponent(f.id)}" download>Herunterladen</a></div>`;
        const team = files.filter((f) => f.source === 'team');
        const mine = files.filter((f) => f.source === 'customer');
        const err = ERRORS[ctx.query.get('error') ?? ''];
        const notice = ctx.query.get('ok') === '1' ? '<div class="notice">Danke – deine Datei ist angekommen.</div>' : err ? `<div class="pf-err" role="alert">${escapeHtml(err)}</div>` : '';
        let upload = '';
        if (s.uploads) {
          const used = customerBytes(p.locationId, m.contact.id);
          const left = Math.max(0, s.quota_mb * MB - used);
          const accept = s.types.map((t) => ACCEPT[t]).join(',');
          upload = `<section class="pf-up"><h2 class="pf-h">${ICON} Datei an uns senden</h2>
<p class="pf-st">${escapeHtml(s.types.map((t) => CATEGORY_LABEL[t]).join(', '))} · höchstens ${s.max_mb} MB je Datei · noch ${size(left)} frei</p>
<form method="post" action="${base(p)}" enctype="multipart/form-data"><input type="hidden" name="csrf" value="${csrf(m)}"><label class="pf-st" for="pf-file">Datei</label><input id="pf-file" type="file" name="file" required accept="${escapeHtml(accept)}"><button class="btn">Hochladen</button></form></section>`;
        }
        const body = `<div class="crumb"><a href="${p.base}">Start</a></div><h1>Meine Dateien</h1>${notice}
${team.length ? team.map(row).join('') : '<div class="panel empty"><p class="muted">Noch keine Dateien für dich freigegeben.</p></div>'}
${upload}
${mine.length ? `<h2 style="margin-top:28px">Von dir gesendet</h2>${mine.map(row).join('')}` : ''}`;
        return k.page(p, { title: 'Meine Dateien', body, member: m });
      }),
    );

    router.get('/portal/:p/documents/:docId', 'public', (ctx) =>
      withMember(ctx, (k, p, m) => {
        const d = db.get<any>(
          `SELECT d.id, d.name, d.mime, f.downloads, f.source, (SELECT b.data FROM contact_document_blobs b WHERE b.doc_id = d.id) AS data
           FROM portal_files f JOIN contact_documents d ON d.id = f.doc_id
           WHERE f.doc_id = ? AND f.location_id = ? AND f.contact_id = ? AND f.shared = 1 AND d.location_id = f.location_id AND d.contact_id = f.contact_id AND d.private = 0`,
          ctx.params.docId,
          p.locationId,
          m.contact.id,
        );
        if (!d?.data) return k.notFoundPage(p, m);
        db.run('UPDATE portal_files SET downloads = downloads + 1, last_download_at = ? WHERE doc_id = ?', now(), d.id);
        if (!d.downloads && d.source === 'team') logActivity(app, p.locationId, m.contact.id, 'portal.file_downloaded', `Datei im Kundenportal geöffnet: ${d.name}`, { document_id: d.id });
        return {
          __raw: true,
          status: 200,
          headers: {
            // Always a download, never rendered by the browser; the type list has no HTML or SVG in the first place.
            'content-type': DOC_TYPES[d.mime] ? d.mime : 'application/octet-stream',
            'content-disposition': `attachment; filename="${String(d.name).replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(d.name)}`,
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox",
            'cache-control': 'private, no-store',
            'referrer-policy': 'no-referrer',
          },
          body: Buffer.from(d.data as Uint8Array),
        } satisfies RawResult;
      }),
    );

    const customerBytes = (loc: string, cid: string) =>
      db.get<{ s: number }>(`SELECT COALESCE(SUM(d.size), 0) AS s FROM portal_files f JOIN contact_documents d ON d.id = f.doc_id WHERE f.location_id = ? AND f.contact_id = ? AND f.source = 'customer'`, loc, cid)!.s;

    router.post('/portal/:p/documents', 'public', (ctx) =>
      withMember(ctx, (k, p, m) => {
        const back = (code: string) => redirect(`${base(p)}?${code === 'ok' ? 'ok=1' : `error=${code}`}`, 303);
        const s = settingsOf(p.locationId);
        if (!s.uploads) return back('off');
        let form: ReturnType<typeof parseMultipart>;
        try {
          form = parseMultipart(ctx.rawBuffer ?? Buffer.alloc(0), ctx.req.headers['content-type']);
        } catch {
          return back('form');
        }
        if (!k.sameOrigin(ctx) || !safeEqual(form.fields.csrf, csrf(m))) return back('form');
        const file = form.files.find((f) => f.field === 'file');
        if (!file || !file.data.length) return back('empty');
        let name: string;
        try {
          name = cleanName(file.filename);
        } catch {
          return back('empty');
        }
        // The type comes from the name, never from what the browser claims; the bytes must match it.
        const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
        const mime = BY_EXT[ext];
        if (!mime || !s.types.some((t) => CATEGORIES[t](mime))) return back('type');
        if (file.data.length > s.max_mb * MB) return back('size');
        if (!contentMatches(mime, file.data)) return back('content');
        const loc = p.locationId;
        const cid = m.contact.id;
        const since = new Date(Date.now() - 864e5).toISOString();
        if (db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM portal_files WHERE location_id = ? AND contact_id = ? AND source = 'customer' AND created_at > ?`, loc, cid, since)!.n >= UPLOADS_PER_DAY) return back('count');
        if (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contact_documents WHERE contact_id = ?', cid)!.n >= PER_CONTACT) return back('count');
        if (customerBytes(loc, cid) + file.data.length > s.quota_mb * MB) return back('quota');
        const cap = docsCap();
        if (cap !== null && db.get<{ s: number }>('SELECT COALESCE(SUM(size), 0) AS s FROM contact_documents WHERE location_id = ?', loc)!.s + file.data.length > cap) return back('quota');
        const docId = id();
        const at = now();
        db.tx(() => {
          db.insert('contact_documents', { id: docId, location_id: loc, contact_id: cid, note_id: null, name, mime, size: file.data.length, private: 0, created_by: null, created_at: at });
          db.insert('contact_document_blobs', { doc_id: docId, data: file.data });
          db.insert('portal_files', { doc_id: docId, location_id: loc, contact_id: cid, source: 'customer', shared: 1, shared_by: null, created_at: at, shared_at: at });
        });
        logActivity(app, loc, cid, 'portal.file_uploaded', `Datei im Kundenportal hochgeladen: ${name}`, { document_id: docId, size: file.data.length });
        app.events.emit(loc, 'portal.file_uploaded', { contactId: cid, documentId: docId, name, mime, size: file.data.length });
        if (s.notify) {
          const c = getContact(app, loc, cid);
          const who = [c?.first_name, c?.last_name].filter(Boolean).join(' ') || c?.email || 'Ein Kunde';
          const owner = c?.assigned_to ? [String(c.assigned_to)] : [];
          const to = owner.length ? owner : membersWhere(app, loc, (u) => u.role === 'admin').slice(0, 5);
          for (const userId of to) notifyMember(app, { locationId: loc, userId, kind: 'portal_file', title: `${who} hat eine Datei gesendet`, body: name, link: `/app/contacts/${cid}`, ref: `portal-file:${docId}`, area: 'contacts' });
        }
        return back('ok');
      }),
    );
  },
};
