import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256, token } from '../server/core/util.js';
import { parseMultipart } from '../server/modules/portal-files.js';
import { startTestApp } from './helpers.js';

/** Files in the customer portal (modules/portal-files.ts): sharing, download, customer uploads, isolation, MCP tools. */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let mia = '';
let ole = '';
let key = '';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const cookieFor = (contactId: string) => {
  const raw = token(32);
  t.app.db.run('INSERT INTO member_sessions (token_hash, location_id, contact_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', sha256(raw), loc, contactId, new Date().toISOString(), new Date(Date.now() + 864e5).toISOString());
  return `pm_${loc}=${raw}`;
};
const get = async (path: string, cookie = '') => {
  const r = await t.api.raw(path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) };
};
const page = async (path: string, cookie: string) => (await get(path, cookie)).body.toString('utf8');
const addDoc = async (contact: string, name: string, data: Buffer, extra: Record<string, unknown> = {}) => (await t.api.post(`/api/contacts/${contact}/documents`, { name, data: data.toString('base64'), ...extra })).data;
const share = (contact: string, doc: string, shared = true) => t.api.put(`/api/contacts/${contact}/documents/${doc}/portal`, { shared });
/** Posts the portal's upload form as a browser would (multipart). */
const upload = async (cookie: string, filename: string, data: Buffer, csrf?: string) => {
  const html = await page(`/portal/${loc}/documents`, cookie);
  const tokenValue = csrf ?? /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
  const fd = new FormData();
  fd.append('csrf', tokenValue);
  fd.append('file', new Blob([data]), filename);
  const r = await t.api.raw(`/portal/${loc}/documents`, { method: 'POST', body: fd, redirect: 'manual', headers: { cookie } });
  return { status: r.status, location: r.headers.get('location') ?? '' };
};
const mcp = async (name: string, args: any) => {
  const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const j: any = await r.json();
  const text = j.result?.content?.[0]?.text ?? '';
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* error text */
  }
  return { isError: !!j.result?.isError, text, data };
};

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  mia = (await t.api.post('/api/contacts', { first_name: 'Mia', email: 'mia@example.com' })).data.id;
  ole = (await t.api.post('/api/contacts', { first_name: 'Ole', email: 'ole@example.com' })).data.id;
  key = (await t.api.post('/api/api-keys', { name: 'Portal-Test' })).data.key;
});
afterAll(async () => {
  await t.close();
});

describe('sharing a contact document in the portal', () => {
  it('shows a shared file only to its own contact and serves it as a download', async () => {
    const offer = await addDoc(mia, 'Angebot <Mia>.pdf', PDF);
    const other = await addDoc(ole, 'Ole-Vertrag.pdf', PDF);
    const r = await share(mia, offer.id);
    expect(r.status).toBe(200);
    expect(r.data.files).toHaveLength(1);
    expect(r.data.files[0]).toMatchObject({ doc_id: offer.id, source: 'team', shared: true, downloads: 0 });
    expect(r.data.portal_url).toContain(`/portal/${loc}/documents`);
    await share(ole, other.id);

    const miaCookie = cookieFor(mia);
    const oleCookie = cookieFor(ole);
    const html = await page(`/portal/${loc}/documents`, miaCookie);
    expect(html).toContain('Meine Dateien');
    expect(html).toContain('Angebot &lt;Mia&gt;.pdf');
    expect(html).not.toContain('Ole-Vertrag');
    // Start page: header link and the "new files" block.
    const start = await page(`/portal/${loc}`, miaCookie);
    expect(start).toContain(`/portal/${loc}/documents`);
    expect(start).toContain('Neue Dateien für dich (1)');

    const dl = await get(`/portal/${loc}/documents/${offer.id}`, miaCookie);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(dl.headers.get('x-content-type-options')).toBe('nosniff');
    expect(dl.headers.get('content-security-policy')).toContain('sandbox');
    expect(dl.body.equals(PDF)).toBe(true);
    const after = (await t.api.get(`/api/contacts/${mia}/portal-files`)).data.files[0];
    expect(after.downloads).toBe(1);
    expect(t.app.db.get<any>(`SELECT COUNT(*) AS n FROM activities WHERE contact_id = ? AND type = 'portal.file_downloaded'`, mia).n).toBe(1);
    await get(`/portal/${loc}/documents/${offer.id}`, miaCookie);
    expect(t.app.db.get<any>(`SELECT COUNT(*) AS n FROM activities WHERE contact_id = ? AND type = 'portal.file_downloaded'`, mia).n).toBe(1);

    // IDOR: Ole cannot fetch Mia's file by id, nor anybody without a session.
    expect((await get(`/portal/${loc}/documents/${offer.id}`, oleCookie)).status).toBe(404);
    expect((await get(`/portal/${loc}/documents/${other.id}`, miaCookie)).status).toBe(404);
    expect((await get(`/portal/${loc}/documents/${offer.id}`)).status).toBe(401);
    // …and the team cannot share a file through the wrong contact.
    expect((await share(ole, offer.id)).status).toBe(404);

    // Unsharing hides it again.
    await share(mia, offer.id, false);
    expect((await get(`/portal/${loc}/documents/${offer.id}`, miaCookie)).status).toBe(404);
    expect(await page(`/portal/${loc}/documents`, miaCookie)).not.toContain('Angebot');
    await share(mia, offer.id, true);
    expect((await get(`/portal/${loc}/documents/${offer.id}`, miaCookie)).status).toBe(200);
  });

  it('never shares a "nur für mich" file and hides one made private later', async () => {
    const secret = await addDoc(mia, 'intern.pdf', PDF, { private: true });
    const r = await share(mia, secret.id);
    expect(r.status).toBe(400);
    const open = await addDoc(mia, 'spaeter-privat.pdf', PDF);
    await share(mia, open.id);
    await t.api.patch(`/api/contacts/${mia}/documents/${open.id}`, { private: true });
    expect((await get(`/portal/${loc}/documents/${open.id}`, cookieFor(mia))).status).toBe(404);
  });

  it('lets a contact with shared files log in to the portal', () => {
    const checks = t.app.services.portalMemberCheck as ((l: string, c: string) => boolean)[];
    expect(checks.some((fn) => fn(loc, mia))).toBe(true);
    const nobody = t.app.db.get<any>(`SELECT id FROM contacts WHERE location_id = ? AND id NOT IN (?, ?)`, loc, mia, ole);
    if (nobody) expect(checks.some((fn) => fn(loc, nobody.id))).toBe(false);
  });
});

describe('customer uploads', () => {
  it('are off by default', async () => {
    const r = await upload(cookieFor(ole), 'scan.pdf', PDF);
    expect(r.location).toContain('error=off');
    expect(await page(`/portal/${loc}/documents`, cookieFor(ole))).not.toContain('enctype="multipart/form-data"');
  });

  it('land on the contact with an activity, an event and a notification', async () => {
    const s = await t.api.put('/api/portal-files/settings', { uploads: true, max_mb: 1, quota_mb: 2, types: ['pdf', 'text', 'bogus'] });
    expect(s.status).toBe(200);
    expect(s.data).toMatchObject({ uploads: true, max_mb: 1, quota_mb: 2, types: ['pdf', 'text'] });
    const events: any[] = [];
    t.app.events.on('portal.file_uploaded', (e: any) => void events.push(e));

    const cookie = cookieFor(ole);
    expect(await page(`/portal/${loc}/documents`, cookie)).toContain('enctype="multipart/form-data"');
    const r = await upload(cookie, 'Lohnzettel.pdf', PDF);
    expect(r.status).toBe(303);
    expect(r.location).toContain('ok=1');
    const docs = (await t.api.get(`/api/contacts/${ole}/documents`)).data;
    const doc = docs.find((d: any) => d.name === 'Lohnzettel.pdf');
    expect(doc).toMatchObject({ mime: 'application/pdf', size: PDF.length, private: false });
    const pf = (await t.api.get(`/api/contacts/${ole}/portal-files`)).data.files.find((f: any) => f.doc_id === doc.id);
    expect(pf.source).toBe('customer');
    expect(t.app.db.get<any>(`SELECT COUNT(*) AS n FROM activities WHERE contact_id = ? AND type = 'portal.file_uploaded'`, ole).n).toBe(1);
    expect(events.some((e) => e.data?.documentId === doc.id || e.documentId === doc.id)).toBe(true);
    expect(t.app.db.get<any>(`SELECT COUNT(*) AS n FROM pm_notifications WHERE ref = ?`, `portal-file:${doc.id}`).n).toBe(1);
    // The customer sees their own upload, Mia does not.
    expect(await page(`/portal/${loc}/documents`, cookie)).toContain('Von dir gesendet');
    expect((await get(`/portal/${loc}/documents/${doc.id}`, cookieFor(mia))).status).toBe(404);
  });

  it('refuses HTML, SVG, disguised content, wrong tokens, oversize files and a full quota', async () => {
    const cookie = cookieFor(ole);
    const count = () => t.app.db.get<any>(`SELECT COUNT(*) AS n FROM contact_documents WHERE contact_id = ?`, ole).n;
    const before = count();
    expect((await upload(cookie, 'seite.html', Buffer.from('<html><script>alert(1)</script></html>'))).location).toContain('error=type');
    expect((await upload(cookie, 'bild.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).location).toContain('error=type');
    expect((await upload(cookie, 'notiz.txt', Buffer.from('<script>alert(1)</script>'))).location).toContain('error=content');
    expect((await upload(cookie, 'fake.pdf', Buffer.from('<html>nope</html>'))).location).toContain('error=content');
    expect((await upload(cookie, 'foto.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).location).toContain('error=type');
    expect((await upload(cookie, 'notiz.txt', Buffer.from('hallo'), 'falsch')).location).toContain('error=form');
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1.2 * 1024 * 1024, 0x20)]);
    expect((await upload(cookie, 'gross.pdf', big)).location).toContain('error=size');
    const part = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(0.9 * 1024 * 1024, 0x20)]);
    expect((await upload(cookie, 'teil1.pdf', part)).location).toContain('ok=1');
    expect((await upload(cookie, 'teil2.pdf', part)).location).toContain('ok=1');
    expect((await upload(cookie, 'teil3.pdf', part)).location).toContain('error=quota');
    expect(count()).toBe(before + 2);
    // A text file with plain text is fine – and it comes back as a download, never inline.
    await t.api.put('/api/portal-files/settings', { quota_mb: 10 });
    expect((await upload(cookie, 'notiz.txt', Buffer.from('Hallo, anbei die Nummer.'))).location).toContain('ok=1');
    const txt = (await t.api.get(`/api/contacts/${ole}/documents`)).data.find((d: any) => d.name === 'notiz.txt');
    const dl = await get(`/portal/${loc}/documents/${txt.id}`, cookie);
    expect(dl.headers.get('content-type')).toBe('text/plain');
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('refuses a post without a member session', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([PDF]), 'x.pdf');
    const r = await t.api.raw(`/portal/${loc}/documents`, { method: 'POST', body: fd, redirect: 'manual' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe(`/portal/${loc}`);
  });
});

describe('multipart parsing', () => {
  it('reads fields and the file and ignores junk', () => {
    const b = 'XyZ';
    const body = Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\nabc\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\n`),
      Buffer.from('hi\r\nthere'),
      Buffer.from(`\r\n--${b}--\r\n`),
    ]);
    const r = parseMultipart(body, `multipart/form-data; boundary=${b}`);
    expect(r.fields.csrf).toBe('abc');
    expect(r.files[0].filename).toBe('a.txt');
    expect(r.files[0].data.toString()).toBe('hi\r\nthere');
    expect(() => parseMultipart(body, 'application/json')).toThrow();
  });
});

describe('MCP tools', () => {
  it('lists a contact’s portal files and shares / unshares one', async () => {
    const doc = await addDoc(ole, 'Agent.pdf', PDF);
    const shared = await mcp('ghl_portal_file_share', { location_id: loc, contact_id: ole, document_id: doc.id, shared: true });
    expect(shared.isError).toBe(false);
    const list = await mcp('ghl_portal_files', { location_id: loc, contact_id: ole });
    expect(list.data.files.some((f: any) => f.doc_id === doc.id && f.shared)).toBe(true);
    expect(list.data.uploads).toBe(true);
    await mcp('ghl_portal_file_share', { location_id: loc, contact_id: ole, document_id: doc.id, shared: false });
    const again = await mcp('ghl_portal_files', { location_id: loc, contact_id: ole });
    expect(again.data.files.find((f: any) => f.doc_id === doc.id).shared).toBe(false);
    // Another contact's document through the wrong contact is not found.
    const wrong = await mcp('ghl_portal_file_share', { location_id: loc, contact_id: mia, document_id: doc.id, shared: true });
    expect(wrong.isError).toBe(true);
  });
});
