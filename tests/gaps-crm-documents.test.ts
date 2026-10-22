import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanName } from '../server/modules/contact-documents.js';
import { client } from './security-fixtures.js';
import { startTestApp } from './helpers.js';

/** Documents on a contact and attachments on notes (modules/contact-documents.ts). */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let member: ReturnType<typeof client>;
let memberId = '';
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  const u = await t.api.post('/api/users', { email: 'mia@example.com', password: 'passwort-123', name: 'Mia', locations: [loc], permissions: ['contacts', 'conversations'] });
  expect(u.status, JSON.stringify(u.data)).toBe(200);
  memberId = u.data.id;
  member = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
  expect((await member('POST', '/api/auth/login', { email: 'mia@example.com', password: 'passwort-123' })).status).toBe(200);
});
afterAll(() => t?.close());

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a3f00000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

describe('contact documents and note attachments', () => {
  let contact = '';
  let note = '';
  let doc = '';
  it('cleans file names', () => {
    expect(cleanName('C:\\Users\\x\\Vertrag "neu".pdf')).toBe('Vertrag neu.pdf');
    expect(() => cleanName('  ')).toThrow();
  });

  it('uploads a file to a contact and one to a note; lists them without the bytes', async () => {
    contact = (await t.api.post('/api/contacts', { email: 'kunde@example.com', first_name: 'Kunde' })).data.id;
    note = (await t.api.post(`/api/contacts/${contact}/notes`, { body: 'Vor-Ort-Termin' })).data.id;
    const a = await t.api.post(`/api/contacts/${contact}/documents`, { name: 'Vertrag.pdf', data: PDF.toString('base64') });
    expect(a.status, JSON.stringify(a.data)).toBe(200);
    expect(a.data).toMatchObject({ name: 'Vertrag.pdf', mime: 'application/pdf', size: PDF.length, note_id: null, private: false });
    expect(a.data.data).toBeUndefined();
    doc = a.data.id;
    const b = await t.api.post(`/api/contacts/${contact}/documents`, { name: 'foto.png', data: `data:image/png;base64,${PNG.toString('base64')}`, note_id: note });
    expect(b.status, JSON.stringify(b.data)).toBe(200);
    expect(b.data.note_id).toBe(note);
    const list = (await t.api.get(`/api/contacts/${contact}/documents`)).data;
    expect(list.map((x: any) => x.name)).toEqual(['foto.png', 'Vertrag.pdf']);
    expect(list[0]).toMatchObject({ note_title: '', user_name: 'Chef' });
    expect(list.every((x: any) => x.data === undefined)).toBe(true);
  });

  it('downloads only through the signed-in route, as attachment with nosniff and a sandbox CSP (images may show inline)', async () => {
    const r = await t.api.raw(`/api/contacts/${contact}/documents/${doc}`, { headers: { cookie: t.api.cookie, 'x-location-id': loc } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="Vertrag.pdf"/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toContain('sandbox');
    expect(Buffer.from(await r.arrayBuffer()).equals(PDF)).toBe(true);
    const img = (await t.api.get(`/api/contacts/${contact}/documents`)).data.find((x: any) => x.name === 'foto.png');
    const inline = await t.api.raw(`${img.url}?inline=1`, { headers: { cookie: t.api.cookie, 'x-location-id': loc } });
    expect(inline.headers.get('content-disposition')).toMatch(/^inline/);
    expect((await t.api.raw(`/api/contacts/${contact}/documents/${doc}`)).status).toBe(401);
  });

  it('refuses wrong types, disguised content, foreign notes and oversize files', async () => {
    expect((await t.api.post(`/api/contacts/${contact}/documents`, { name: 'x.html', data: Buffer.from('<html>').toString('base64') })).status).toBe(400);
    expect((await t.api.post(`/api/contacts/${contact}/documents`, { name: 'fake.png', data: Buffer.from('<script>alert(1)</script>').toString('base64') })).status).toBe(400);
    expect((await t.api.post(`/api/contacts/${contact}/documents`, { name: 'leer.pdf', data: '' })).status).toBe(400);
    const other = (await t.api.post('/api/contacts', { email: 'anders@example.com' })).data.id;
    const otherNote = (await t.api.post(`/api/contacts/${other}/notes`, { body: 'x' })).data.id;
    expect((await t.api.post(`/api/contacts/${contact}/documents`, { name: 'a.pdf', data: PDF.toString('base64'), note_id: otherNote })).status).toBe(400);
    const big = Buffer.concat([PDF, Buffer.alloc(8 * 1024 * 1024)]);
    expect((await t.api.post(`/api/contacts/${contact}/documents`, { name: 'gross.pdf', data: big.toString('base64') })).status).toBe(400);
    expect((await t.api.post('/api/contacts/nope/documents', { name: 'a.pdf', data: PDF.toString('base64') })).status).toBe(404);
  });

  it('"nur für mich": a private file is the uploader\'s and the admins\'; others neither see nor delete it', async () => {
    const mine = await member('POST', `/api/contacts/${contact}/documents`, { name: 'privat.pdf', data: PDF.toString('base64'), private: true });
    expect(mine.status, JSON.stringify(mine.data)).toBe(200);
    expect(mine.data.created_by).toBe(memberId);
    const adminList = (await t.api.get(`/api/contacts/${contact}/documents`)).data.map((x: any) => x.name);
    expect(adminList).toContain('privat.pdf');
    // The admin makes one of their own private: the member does not see it.
    const p = await t.api.patch(`/api/contacts/${contact}/documents/${doc}`, { private: true, name: 'Vertrag 2026.pdf' });
    expect(p.data).toMatchObject({ private: true, name: 'Vertrag 2026.pdf' });
    const memberList = (await member('GET', `/api/contacts/${contact}/documents`)).data.map((x: any) => x.name);
    expect(memberList).toEqual(expect.arrayContaining(['privat.pdf', 'foto.png']));
    expect(memberList).not.toContain('Vertrag 2026.pdf');
    expect((await member('GET', `/api/contacts/${contact}/documents/${doc}`)).status).toBe(404);
    expect((await member('DELETE', `/api/contacts/${contact}/documents/${doc}`)).status).toBe(404);
  });

  it('goes with its note and with its contact, never across sub-accounts', async () => {
    await t.api.del(`/api/notes/${note}`);
    expect((await t.api.get(`/api/contacts/${contact}/documents`)).data.map((x: any) => x.name)).not.toContain('foto.png');
    const otherLoc = (await t.api.post('/api/locations', { name: 'Zweiter Kunde' })).data.id;
    expect((await t.api.get(`/api/contacts/${contact}/documents`, { 'x-location-id': otherLoc })).status).toBe(404);
    expect((await t.api.del(`/api/contacts/${contact}/documents/${doc}`)).status).toBe(200);
    await t.api.del(`/api/contacts/${contact}`);
    expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contact_documents WHERE contact_id = ?', contact)!.n).toBe(0);
  });

  it('lists through a read-only MCP tool', async () => {
    const tool = (t.app.services.mcpTools as any[]).find((x) => x.name === 'ghl_contact_documents');
    expect(tool.annotations.readOnlyHint).toBe(true);
    let path = '';
    await tool.run({ agency: false, api: async (_m: string, p: string) => ((path = p), []) }, { contact_id: 'c 1' });
    expect(path).toBe('/api/contacts/c%201/documents');
  });
});

describe('contact documents in the DSGVO export', () => {
  it('lists the documents (name, type, size) without their bytes', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'export@example.com' })).data.id;
    expect((await t.api.post(`/api/contacts/${c}/documents`, { name: 'Ausweis.png', data: PNG.toString('base64') })).status).toBe(200);
    const r = await t.api.get(`/api/contacts/${c}/privacy-export`);
    expect(r.status).toBe(200);
    const text = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    expect(text).toContain('Ausweis.png');
    const rows = (typeof r.data === 'string' ? JSON.parse(r.data) : r.data).data?.contact_documents ?? [];
    expect(rows).toEqual([expect.objectContaining({ name: 'Ausweis.png', mime: 'image/png', size: PNG.length })]);
    expect(Object.keys(rows[0])).not.toContain('data');
    expect(text).not.toContain(PNG.toString('base64').slice(0, 24));
  });
});
