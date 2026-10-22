import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportTenant } from '../server/services/cloud-export.js';
import { blankFile, extractText } from '../server/services/office-blank.js';
import { cleanCommands, cleanName, kindOf, writesToCommands } from '../server/services/office-model.js';
import { blobPath } from '../server/services/office-store.js';
import { startTestApp } from './helpers.js';
import { client, type Call } from './security-fixtures.js';

/**
 * Office (docs/office.md): files per sub-account with immutable versions, restore, edit lock, comments, sub-account isolation,
 * the permission area, the DSGVO hooks, the export and deletion of a whole sub-account and the browser editor's page (CSP, nonce, bridge, assets, signed PDF link). The agent's
 * engine calls are in office-engine.test.ts.
 */

let t: Awaited<ReturnType<typeof startTestApp>>;
let A = '';
let B = '';
let admin: Call;
let maria: Call;
let mariaId = '';
let otto: Call;

const raw = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => fetch(t.base + path, { ...init, headers: { cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': A, ...(init.headers ?? {}) } });

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  A = t.api.location;
  B = (await t.api.post('/api/locations', { name: 'Zweitfirma' })).data.id;
  admin = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': A });
  const u = await t.api.post('/api/users', { email: 'maria@example.com', name: 'Maria Muster', password: 'geheim-12345', role: 'member', locations: [A], permissions: ['office', 'contacts'] });
  mariaId = u.data.id;
  maria = client(t.base, { 'x-pghl': '1', 'x-location-id': A });
  expect((await maria('POST', '/api/auth/login', { email: 'maria@example.com', password: 'geheim-12345' })).status).toBe(200);
  await t.api.post('/api/users', { email: 'otto@example.com', name: 'Otto Ohne', password: 'geheim-12345', role: 'member', locations: [A], permissions: ['contacts'] });
  otto = client(t.base, { 'x-pghl': '1', 'x-location-id': A });
  expect((await otto('POST', '/api/auth/login', { email: 'otto@example.com', password: 'geheim-12345' })).status).toBe(200);
}, 60_000);

afterAll(async () => {
  delete process.env.PGHL_OFFICE_DIR;
  delete process.env.PGHL_OFFICE_MAX_MB;
  delete process.env.PGHL_OFFICE_QUOTA_MB;
  await t?.close();
});

describe('model and blank files', () => {
  it('names files with their extension, without paths or control characters', () => {
    expect(cleanName('Angebot Müller', 'docx')).toBe('Angebot Müller.docx');
    expect(cleanName('../../etc/passwd', 'xlsx')).toBe('-..-etc-passwd.xlsx');
    expect(cleanName('', 'xlsx')).toBe('Neue Tabelle.xlsx');
    expect(cleanName('Bericht.PDF', 'pdf')).toBe('Bericht.pdf');
    expect(kindOf('application/pdf', 'x')).toBe('pdf');
    expect(kindOf('', 'Folien.pptx')).toBe('pptx');
    expect(kindOf('text/html', 'x.html')).toBeNull();
  });

  it('refuses engine commands that name files, folders or addresses, or open/save by themselves', () => {
    expect(cleanCommands([{ command: 'insert.text', params: { text: 'Hallo' } }], 'docx')).toEqual([{ command: 'insert.text', params: { text: 'Hallo' } }]);
    expect(() => cleanCommands([{ command: 'insert.picture', params: { path: '/etc/passwd' } }], 'docx')).toThrow(/„path“ ist nicht erlaubt/);
    expect(() => cleanCommands([{ command: 'x.y', params: { nested: [{ imageUrl: 'http://x' }] } }], 'docx')).toThrow(/nicht erlaubt/);
    expect(() => cleanCommands([{ command: 'file.save', params: {} }], 'docx')).toThrow(/übernimmt HyperLevel/);
    expect(() => cleanCommands([{ command: 'doc_save', params: {} }], 'pdf')).toThrow(/übernimmt HyperLevel/);
    expect(cleanCommands([{ command: 'page_rotate', params: { pages: [1], degrees: 90 } }], 'pdf')).toHaveLength(1);
    expect(() => cleanCommands('x', 'docx')).toThrow('commands muss eine Liste sein');
    expect(writesToCommands([{ range: 'a1:b2', values: [[1, 'x'], [true, null]], sheet: 'Umsatz' }])).toEqual([
      { command: 'sheet.activate', params: { sheet: 'Umsatz' } },
      { command: 'range.setValues', params: { range: 'A1:B2', values: [[1, 'x'], [true, null]] } },
    ]);
    expect(() => writesToCommands([{ range: 'A1; rm -rf', values: [[1]] }])).toThrow(/Zellbereich/);
  });

  it('makes valid blank files and reads their text without an engine', () => {
    const d = blankFile('docx', { text: 'Erste Zeile\nZweite & <dritte>' });
    expect(d.readUInt32LE(0)).toBe(0x04034b50);
    expect(extractText('docx', d)).toBe('Erste Zeile\nZweite & <dritte>');
    const x = blankFile('xlsx', { rows: [['Monat', 'Umsatz'], ['Januar', 1200], ['Februar', true]] });
    expect(extractText('xlsx', x)).toBe('--- Blatt Tabelle1 ---\nMonat\tUmsatz\nJanuar\t1200\nFebruar\tWAHR');
    expect(extractText('pptx', blankFile('pptx', { text: 'Quartalszahlen' }))).toBe('--- Folie 1 ---\nQuartalszahlen');
    const p = blankFile('pdf', { text: 'Hallo (Welt)' });
    expect(p.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(p.toString('latin1')).toContain('(Hallo \\(Welt\\))');
    expect(p.toString('latin1')).toMatch(/startxref\n\d+\n%%EOF\n$/);
    expect(extractText('pdf', p)).toBeNull();
  });
});

describe('files and versions', () => {
  let doc: any;

  it('creates blank files of every kind and lists them with filters', async () => {
    for (const kind of ['docx', 'xlsx', 'pptx', 'pdf']) {
      const r = await admin('POST', '/api/office/files', { kind, name: `Test ${kind}` });
      expect(r.status, r.text).toBe(200);
      expect(r.data).toMatchObject({ kind, name: `Test ${kind}.${kind}`, version: 1, lock: null });
    }
    doc = (await admin('GET', '/api/office/files?kind=docx')).data[0];
    expect(doc.name).toBe('Test docx.docx');
    expect((await admin('GET', '/api/office/files')).data).toHaveLength(4);
    expect((await admin('GET', '/api/office/files?q=pptx')).data.map((f: any) => f.kind)).toEqual(['pptx']);
    expect((await admin('GET', '/api/office/files?kind=exe')).status).toBe(400);
    const status = (await admin('GET', '/api/office/status')).data;
    expect(status.editors).toEqual({ docx: false, xlsx: false, pptx: false, pdf: false });
    expect(status.sandbox).toBe('strict');
    expect(status.limits.used_bytes).toBeGreaterThan(0);
  });

  it('uploads raw bytes and base64, and checks the content against the kind', async () => {
    const bytes = blankFile('docx', { text: 'Hochgeladen' });
    const up = await raw('/api/office/files?name=Vertrag.docx', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes });
    expect(up.status).toBe(200);
    const f = await up.json();
    expect(f).toMatchObject({ kind: 'docx', name: 'Vertrag.docx', size: bytes.length });
    const b64 = await admin('POST', '/api/office/files', { name: 'Zahlen.xlsx', data: blankFile('xlsx').toString('base64') });
    expect(b64.data.kind).toBe('xlsx');
    // HTML disguised as a document, an executable, an unknown type
    const fake = await admin('POST', '/api/office/files', { name: 'boese.docx', data: Buffer.from('<html><script>alert(1)</script></html>').toString('base64') });
    expect(fake.status).toBe(400);
    expect(fake.data.error).toContain('passt nicht');
    expect((await admin('POST', '/api/office/files', { name: 'x.exe', data: 'TVqQAAMAAAAEAAAA' })).status).toBe(400);
    const dl = await raw(`/api/office/files/${f.id}/download`);
    expect(dl.headers.get('content-disposition')).toContain("filename*=UTF-8''Vertrag.docx");
    expect(Buffer.from(await dl.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('enforces the size limit and the quota', async () => {
    process.env.PGHL_OFFICE_MAX_MB = '0.001';
    const big = await admin('POST', '/api/office/files', { kind: 'docx', name: 'Groß', text: 'x'.repeat(5000) });
    expect(big.status).toBe(413);
    delete process.env.PGHL_OFFICE_MAX_MB;
    process.env.PGHL_OFFICE_QUOTA_MB = '0.0001';
    const full = await admin('POST', '/api/office/files', { kind: 'pdf', name: 'Voll' });
    expect(full.status).toBe(413);
    expect(full.data.error).toContain('PGHL_OFFICE_QUOTA_MB');
    delete process.env.PGHL_OFFICE_QUOTA_MB;
  });

  it('every save is a new, immutable version with its author; restore adds one more', async () => {
    const v2 = await raw(`/api/office/files/${doc.id}/versions?message=Kapitel%202&base_version=1`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: blankFile('docx', { text: 'Zweite Fassung' }) });
    expect(v2.status).toBe(200);
    expect((await v2.json()).saved_version).toBe(2);
    // somebody saving on top of an old version: 409 with the current one, then deliberately
    const stale = await maria('POST', `/api/office/files/${doc.id}/versions`, { data: blankFile('docx', { text: 'Marias' }).toString('base64'), base_version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.data).toMatchObject({ current_version: 2, updated_by: 'Chef' });
    const forced = await maria('POST', `/api/office/files/${doc.id}/versions`, { data: blankFile('docx', { text: 'Marias' }).toString('base64'), base_version: 1, force: true, message: 'Meine Fassung' });
    expect(forced.data.saved_version).toBe(3);
    const list = (await admin('GET', `/api/office/files/${doc.id}/versions`)).data;
    expect(list.map((v: any) => [v.version, v.author_name, v.author_kind, v.message])).toEqual([
      [3, 'Maria Muster', 'user', 'Meine Fassung'],
      [2, 'Chef', 'user', 'Kapitel 2'],
      [1, 'Chef', 'user', 'Neu angelegt'],
    ]);
    expect(() => t.app.db.run('UPDATE office_versions SET message = ? WHERE file_id = ?', 'manipuliert', doc.id)).toThrow(/unveränderlich/);
    const restored = await admin('POST', `/api/office/files/${doc.id}/versions/2/restore`);
    expect(restored.data.saved_version).toBe(4);
    const v4 = await raw(`/api/office/files/${doc.id}/raw?version=4`);
    expect(extractText('docx', Buffer.from(await v4.arrayBuffer()))).toBe('Zweite Fassung');
    expect((await admin('GET', `/api/office/files/${doc.id}/versions`)).data[0]).toMatchObject({ version: 4, restored_from: 2, message: 'Version 2 wiederhergestellt' });
    expect((await admin('POST', `/api/office/files/${doc.id}/versions/4/restore`)).status).toBe(400);
    expect((await admin('POST', `/api/office/files/${doc.id}/versions/99/restore`)).status).toBe(404);
  });

  it('renames, links to a contact and deal of the same sub-account only, and audits create, restore and delete', async () => {
    const c = (await admin('POST', '/api/contacts', { first_name: 'Erika', last_name: 'Kundin', email: 'erika@example.com' })).data;
    const r = await admin('PATCH', `/api/office/files/${doc.id}`, { name: 'Angebot Erika', contact_id: c.id ?? c.contact?.id });
    expect(r.data).toMatchObject({ name: 'Angebot Erika.docx', contact_id: c.id ?? c.contact?.id });
    t.api.setLocation(B);
    const foreign = (await t.api.post('/api/contacts', { first_name: 'Fremd', email: 'fremd@example.com' })).data;
    t.api.setLocation(A);
    expect((await admin('PATCH', `/api/office/files/${doc.id}`, { contact_id: foreign.id ?? foreign.contact?.id })).data.error).toBe('Kontakt nicht gefunden');
    expect((await admin('POST', '/api/office/files', { kind: 'docx', name: 'x', deal_id: 'gibtsnicht' })).status).toBe(400);
    const actions = t.app.db.all<{ route: string }>(`SELECT route FROM audit_log WHERE route LIKE '% /api/office/%'`).map((x) => x.route);
    expect(actions).toEqual(expect.arrayContaining(['POST /api/office/files', 'POST /api/office/files/:id/versions/:version/restore', 'PATCH /api/office/files/:id']));
  });

  it('keeps sub-accounts apart and needs the office area', async () => {
    const other = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': B });
    expect((await other('GET', `/api/office/files/${doc.id}`)).status).toBe(404);
    expect((await other('GET', `/api/office/files/${doc.id}/download`)).status).toBe(404);
    expect((await other('DELETE', `/api/office/files/${doc.id}`)).status).toBe(404);
    expect((await other('GET', '/api/office/files')).data).toEqual([]);
    expect((await otto('GET', '/api/office/files')).status).toBe(403);
    expect((await otto('POST', '/api/office/files', { kind: 'docx', name: 'x' })).status).toBe(403);
    expect((await maria('GET', '/api/office/files')).status).toBe(200);
    // a member of A cannot point the request at B
    const sneaky = client(t.base, { 'x-pghl': '1', 'x-location-id': B });
    await sneaky('POST', '/api/auth/login', { email: 'maria@example.com', password: 'geheim-12345' });
    expect((await sneaky('GET', '/api/office/files')).status).toBe(403);
  });

  it('deletes a file with every version from disk', async () => {
    const f = (await admin('POST', '/api/office/files', { kind: 'pdf', name: 'Weg damit' })).data;
    await admin('POST', `/api/office/files/${f.id}/versions`, { data: blankFile('pdf', { text: 'v2' }).toString('base64') });
    const blobs = t.app.db.all<{ blob: string }>('SELECT blob FROM office_versions WHERE file_id = ?', f.id).map((b) => blobPath(t.app, b.blob));
    expect(blobs).toHaveLength(2);
    for (const b of blobs) expect(existsSync(b)).toBe(true);
    expect((await admin('DELETE', `/api/office/files/${f.id}`)).status).toBe(200);
    for (const b of blobs) expect(existsSync(b)).toBe(false);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM office_versions WHERE file_id = ?', f.id)).toEqual({ n: 0 });
  });
});

describe('edit lock and comments', () => {
  let f: any;
  beforeAll(async () => {
    f = (await admin('POST', '/api/office/files', { kind: 'xlsx', name: 'Planung' })).data;
  });

  it('one person edits, everybody else is told who and until when', async () => {
    const lock = await maria('POST', `/api/office/files/${f.id}/lock`);
    expect(lock.status).toBe(200);
    expect(lock.data.lock).toMatchObject({ user_name: 'Maria Muster', mine: true });
    expect((await admin('GET', '/api/office/files?kind=xlsx')).data.find((x: any) => x.id === f.id).lock.user_name).toBe('Maria Muster');
    // the admin's save, lock and delete are refused while Maria holds it
    const save = await admin('POST', `/api/office/files/${f.id}/versions`, { data: blankFile('xlsx').toString('base64') });
    expect(save.status).toBe(423);
    expect(save.data.error).toMatch(/^Maria Muster bearbeitet die Datei gerade/);
    expect(save.data.locked_by).toBe('Maria Muster');
    expect((await admin('POST', `/api/office/files/${f.id}/lock`)).status).toBe(423);
    expect((await admin('DELETE', `/api/office/files/${f.id}`)).status).toBe(423);
    // Maria saves; renewing keeps the lock hers
    expect((await maria('POST', `/api/office/files/${f.id}/versions`, { data: blankFile('xlsx', { rows: [[1]] }).toString('base64') })).data.saved_version).toBe(2);
    expect((await maria('POST', `/api/office/files/${f.id}/lock`)).data.renewed).toBe(true);
  });

  it('expires on its own, can be taken over by an admin and released by its holder', async () => {
    t.app.db.run('UPDATE office_locks SET expires_at = ? WHERE file_id = ?', new Date(Date.now() - 1000).toISOString(), f.id);
    expect((await admin('GET', `/api/office/files/${f.id}/lock`)).data.lock).toBeNull();
    expect((await admin('POST', `/api/office/files/${f.id}/lock`)).data.lock.user_name).toBe('Chef');
    expect((await maria('POST', `/api/office/files/${f.id}/lock`, { take_over: true })).status).toBe(403);
    expect((await maria('DELETE', `/api/office/files/${f.id}/lock`)).status).toBe(403);
    await maria('POST', `/api/office/files/${f.id}/lock`).then((r) => expect(r.status).toBe(423));
    t.app.db.run('DELETE FROM office_locks WHERE file_id = ?', f.id);
    await maria('POST', `/api/office/files/${f.id}/lock`);
    expect((await admin('POST', `/api/office/files/${f.id}/lock`, { take_over: true })).data.lock.user_name).toBe('Chef');
    expect((await admin('DELETE', `/api/office/files/${f.id}/lock`)).status).toBe(200);
    expect((await admin('GET', `/api/office/files/${f.id}/lock`)).data.lock).toBeNull();
  });

  it('a key or MCP connection cannot check a file out', async () => {
    const key = (await admin('POST', '/api/api-keys', { name: 'Sperrtest' })).data.key;
    const r = await fetch(`${t.base}/api/office/files/${f.id}/lock`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(403);
  });

  it('comments per file or version with @mentions, resolve and delete', async () => {
    const c = await admin('POST', `/api/office/files/${f.id}/comments`, { body: 'Bitte prüfen, @Maria Muster', version: 2 });
    expect(c.status, c.text).toBe(200);
    expect(c.data).toMatchObject({ version: 2, mentions: [mariaId], author_name: 'Chef' });
    expect((await admin('POST', `/api/office/files/${f.id}/comments`, { body: 'x', version: 9 })).status).toBe(400);
    const reply = await maria('POST', `/api/office/files/${f.id}/comments`, { body: 'Erledigt', parent_id: c.data.id });
    expect(reply.data.parent_id).toBe(c.data.id);
    expect((await maria('PATCH', `/api/office/files/${f.id}/comments/${c.data.id}`, { body: 'nicht meins' })).status).toBe(403);
    expect((await maria('PATCH', `/api/office/files/${f.id}/comments/${c.data.id}`, { resolved: true })).data.resolved_at).toBeTruthy();
    expect((await admin('GET', `/api/office/files/${f.id}/comments`)).data).toHaveLength(2);
    expect((await maria('DELETE', `/api/office/files/${f.id}/comments/${c.data.id}`)).status).toBe(403);
    expect((await admin('DELETE', `/api/office/files/${f.id}/comments/${c.data.id}`)).status).toBe(200);
    expect((await admin('GET', `/api/office/files/${f.id}/comments`)).data).toHaveLength(0);
    expect((await admin('GET', '/api/office/people')).data.map((p: any) => p.name)).toEqual(expect.arrayContaining(['Chef', 'Maria Muster']));
  });
});

describe('DSGVO: files of a contact', () => {
  it('are part of the Art. 15 export and go with the erasure, bytes on disk included', async () => {
    const c = (await admin('POST', '/api/contacts', { first_name: 'Dora', last_name: 'Datenschutz', email: 'dora@example.com' })).data;
    const cid = c.id ?? c.contact?.id;
    const f = (await admin('POST', '/api/office/files', { kind: 'docx', name: 'Doras Vertrag', contact_id: cid, text: 'Vertrag mit Dora' })).data;
    await admin('POST', `/api/office/files/${f.id}/comments`, { body: 'Unterschrift fehlt' });
    const blob = blobPath(t.app, t.app.db.get<{ blob: string }>('SELECT blob FROM office_versions WHERE file_id = ?', f.id)!.blob);
    const out = (await admin('GET', `/api/contacts/${cid}/privacy-export`)).data;
    expect(out.data.office_files.map((x: any) => x.name)).toEqual(['Doras Vertrag.docx']);
    expect((await admin('POST', `/api/contacts/${cid}/erase`, { confirm: cid })).status).toBe(200);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM office_files WHERE id = ?', f.id)).toEqual({ n: 0 });
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM office_comments WHERE file_id = ?', f.id)).toEqual({ n: 0 });
    expect(existsSync(blob)).toBe(false);
  });
});

describe('a whole sub-account', () => {
  it('its files are in the customer data export and go with the sub-account: rows, comments, locks and every version on disk', async () => {
    const C = (await t.api.post('/api/locations', { name: 'Drittfirma' })).data.id as string;
    const inC = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': C });
    const f = (await inC('POST', '/api/office/files', { kind: 'docx', name: 'Angebot Drittfirma', text: 'Angebot' })).data;
    await inC('POST', `/api/office/files/${f.id}/versions`, { data: blankFile('docx', { text: 'Fassung zwei' }).toString('base64') });
    await inC('POST', `/api/office/files/${f.id}/comments`, { body: 'Bitte prüfen' });
    expect((await inC('POST', `/api/office/files/${f.id}/lock`)).status).toBe(200);
    const kept = (await admin('POST', '/api/office/files', { kind: 'docx', name: 'Bleibt in A' })).data;
    const keptBlob = blobPath(t.app, t.app.db.get<{ blob: string }>('SELECT blob FROM office_versions WHERE file_id = ?', kept.id)!.blob);
    const blobs = t.app.db.all<{ blob: string }>('SELECT blob FROM office_versions WHERE file_id = ?', f.id).map((v) => v.blob);
    expect(blobs).toHaveLength(2);

    const out = exportTenant(t.app, { id: 'x', name: 'Drittfirma' }, [C]);
    for (const b of blobs) expect(out.zip.includes(Buffer.from(`dateien/office-files/${b}`)), b).toBe(true);
    expect(out.zip.includes(Buffer.from('daten/office_versions.json'))).toBe(true);
    expect(out.zip.includes(Buffer.from(keptBlob.split('/').pop()!))).toBe(false);

    expect((await t.api.del(`/api/locations/${C}`)).status).toBe(200);
    for (const table of ['office_files', 'office_versions', 'office_comments', 'office_locks']) expect(t.app.db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE location_id = ?`, C), table).toEqual({ n: 0 });
    for (const b of blobs) expect(existsSync(blobPath(t.app, b)), b).toBe(false);
    expect(existsSync(keptBlob)).toBe(true);
  });
});

describe('browser editor page', () => {
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pghl-office-web-'));
    mkdirSync(join(dir, 'docx'));
    writeFileSync(
      join(dir, 'docx', 'index.html'),
      `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="modulepreload" href="./editor-0123456789abcdef.js"><script type="module" nonce="alt">import init from './editor-0123456789abcdef.js'; await init({ module_or_path: './editor-0123456789abcdef_bg.wasm' }); dispatchEvent(new CustomEvent("TrunkApplicationStarted"));</script></head><body><canvas id="x_canvas"></canvas><div id="x_loading">Loading…</div></body></html>`,
    );
    writeFileSync(join(dir, 'docx', 'editor-0123456789abcdef_bg.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    writeFileSync(join(dir, 'docx', 'editor-0123456789abcdef.js'), 'export default async function init() {}');
    writeFileSync(join(dir, 'secret.txt'), 'geheim');
  });
  afterAll(() => {
    delete process.env.PGHL_OFFICE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('without PGHL_OFFICE_DIR says the editor is not installed (and still needs a login)', async () => {
    delete process.env.PGHL_OFFICE_DIR;
    expect((await fetch(`${t.base}/office/app/docx/`)).status).toBe(401);
    const r = await raw('/office/app/docx/');
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('Editor nicht installiert');
  });

  it('serves the upstream page with a strict CSP for WebAssembly, a nonce on every script and the bridge in front', async () => {
    process.env.PGHL_OFFICE_DIR = dir;
    expect((await admin('GET', '/api/office/status')).data.editors.docx).toBe(true);
    const r = await raw('/office/app/docx/');
    const csp = r.headers.get('content-security-policy')!;
    const nonce = csp.match(/'nonce-([^']+)'/)![1];
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("connect-src 'self' blob:");
    expect(csp).not.toMatch(/https?:|\*/);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const html = await r.text();
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts).toHaveLength(2);
    for (const s of scripts) expect(s).toContain(`nonce="${nonce}"`);
    expect(html).not.toContain('nonce="alt"');
    expect(scripts[0]).toMatch(/src="\/office\/bridge\.js" data-kind="docx" data-exts="docx" data-save="plain" data-target="http:\/\/127\.0\.0\.1:\d+"/);
    expect((await raw('/office/app/docx', { redirect: 'manual' })).status).toBe(301);
    expect((await raw('/office/app/exe/')).status).toBe(404);
  });

  it('serves the build files for the sandboxed page (CORS, wasm type, caching) and nothing outside the folder', async () => {
    process.env.PGHL_OFFICE_DIR = dir;
    const w = await fetch(`${t.base}/office/app/docx/editor-0123456789abcdef_bg.wasm`);
    expect(w.status).toBe(200);
    expect(w.headers.get('content-type')).toBe('application/wasm');
    expect(w.headers.get('access-control-allow-origin')).toBe('*');
    expect(w.headers.get('cache-control')).toContain('immutable');
    for (const bad of ['..%2Fsecret.txt', '%2E%2E%2Fsecret.txt', '.hidden', 'index.html']) expect((await fetch(`${t.base}/office/app/docx/${bad}`)).status, bad).toBeGreaterThanOrEqual(400);
    expect((await fetch(`${t.base}/office/app/docx/..%2F..%2Fsecret.txt`)).status).toBeGreaterThanOrEqual(400);
    const bridge = await fetch(`${t.base}/office/bridge.js`);
    expect(bridge.headers.get('content-type')).toContain('javascript');
    const js = await bridge.text();
    expect(js).toContain('TrunkApplicationStarted');
    expect(js).not.toContain('${');
  });

  it('hands the PDF editor its file through a short-lived signed link', async () => {
    const f = (await admin('POST', '/api/office/files', { kind: 'pdf', name: 'Prospekt' })).data;
    const detail = (await admin('GET', `/api/office/files/${f.id}`)).data;
    expect(detail.editor_file_url).toMatch(/^\/office\/blob\/[^/]+\/Prospekt\.pdf$/);
    const r = await fetch(t.base + detail.editor_file_url);
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect((await r.arrayBuffer()).byteLength).toBe(f.size);
    const tampered = detail.editor_file_url.replace(/\/office\/blob\/([^.]+)\./, (_m: string, p: string) => `/office/blob/${p.slice(0, -2)}xx.`);
    expect((await fetch(t.base + tampered)).status).toBe(404);
    expect((await admin('GET', `/api/office/files/${(await admin('GET', '/api/office/files?kind=docx')).data[0].id}`)).data.editor_file_url).toBeNull();
  });
});
