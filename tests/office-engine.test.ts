import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blankFile } from '../server/services/office-blank.js';
import { ENGINE_LIMITS } from '../server/services/office-engine.js';
import { blobPath } from '../server/services/office-store.js';
import { startTestApp } from './helpers.js';
import { fakeEngines, type FakeEngines } from './office-fakes.js';
import { client, type Call } from './security-fixtures.js';

/**
 * The agent's side of Office (docs/office.md#ai-agent-and-mcp) against fake engines (tests/office-fakes.ts – no real binaries):
 * reading, editing on a copy and storing a new version authored by the agent, range writes, PDF export, the engine's limits
 * (time, output, error text, environment), "engine not installed", the edit lock, and the MCP tools.
 */

let t: Awaited<ReturnType<typeof startTestApp>>;
let A = '';
let admin: Call;
let maria: Call;
let fakes: FakeEngines;
let key = '';

const zipComment = (buf: Buffer) => {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  return buf.subarray(eocd + 22).toString('utf8');
};
const current = (fileId: string) => {
  const v = t.app.db.get<{ blob: string }>('SELECT v.blob FROM office_versions v JOIN office_files f ON f.id = v.file_id AND f.version = v.version WHERE f.id = ?', fileId)!;
  return readFileSync(blobPath(t.app, v.blob));
};
async function mcp(name: string, args: Record<string, unknown>) {
  const r = await fetch(`${t.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const j = await r.json();
  const text: string = j.error ? j.error.message : j.result.content[0].text;
  return { ok: !!j.result && !j.result.isError, text, data: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  A = t.api.location;
  admin = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': A });
  await t.api.post('/api/users', { email: 'maria@example.com', name: 'Maria Muster', password: 'geheim-12345', role: 'member', locations: [A], permissions: ['office'] });
  maria = client(t.base, { 'x-pghl': '1', 'x-location-id': A });
  await maria('POST', '/api/auth/login', { email: 'maria@example.com', password: 'geheim-12345' });
  key = (await admin('POST', '/api/api-keys', { name: 'Agent-Test' })).data.key;
  fakes = fakeEngines();
}, 60_000);

afterAll(async () => {
  delete process.env.PGHL_OFFICE_BIN_DIR;
  await t?.close();
});

describe('without an engine', () => {
  it('reads plain text with HyperLevel’s own extractor and refuses edits with a clear 503', async () => {
    delete process.env.PGHL_OFFICE_BIN_DIR;
    const f = (await admin('POST', '/api/office/files', { kind: 'docx', name: 'Brief', text: 'Sehr geehrte Frau Muster,\nvielen Dank.' })).data;
    const r = await admin('GET', `/api/office/files/${f.id}/read`);
    expect(r.data).toMatchObject({ engine: false, text: 'Sehr geehrte Frau Muster,\nvielen Dank.', version: 1 });
    const e = await admin('POST', `/api/office/files/${f.id}/edit`, { commands: [{ command: 'format.bold' }] });
    expect(e.status).toBe(503);
    expect(e.data.error).toContain('PGHL_OFFICE_BIN_DIR');
    expect((await admin('POST', `/api/office/files/${f.id}/export-pdf`)).status).toBe(503);
    const pdf = (await admin('POST', '/api/office/files', { kind: 'pdf', name: 'Scan' })).data;
    expect((await admin('GET', `/api/office/files/${pdf.id}/read`)).status).toBe(503);
    expect((await admin('GET', '/api/office/status')).data.engines).toEqual({ docx: false, xlsx: false, pptx: false, pdf: false });
  });
});

describe('with the (fake) engines', () => {
  beforeAll(() => {
    process.env.PGHL_OFFICE_BIN_DIR = fakes.dir;
  });

  it('reads text and structure through the engine', async () => {
    expect((await admin('GET', '/api/office/status')).data.engines).toEqual({ docx: true, xlsx: true, pptx: true, pdf: true });
    const f = (await admin('POST', '/api/office/files', { kind: 'docx', name: 'Bericht' })).data;
    const r = (await admin('GET', `/api/office/files/${f.id}/read`)).data;
    expect(r).toMatchObject({ engine: true, text: 'FAKE TEXT in.docx', structure: { engine: 'wordcraft-cli' } });
    expect(r.structure.file).toBeUndefined();
    const x = (await admin('POST', '/api/office/files', { kind: 'xlsx', name: 'Zahlen' })).data;
    expect((await admin('GET', `/api/office/files/${x.id}/read?mode=text&range=A1:B9&sheet=Umsatz`)).data.text).toBe('A,B\n1,2\nrange A1:B9');
    expect((await admin('GET', `/api/office/files/${x.id}/read?range=A1;rm`)).status).toBe(400);
    const p = (await admin('POST', '/api/office/files', { kind: 'pptx', name: 'Folien' })).data;
    expect((await admin('GET', `/api/office/files/${p.id}/read`)).data.text).toBe('Folie eins\n\tHallo Welt\n');
    // the temp copy's path never reaches the reader
    expect(JSON.stringify((await admin('GET', `/api/office/files/${f.id}/read`)).data)).not.toMatch(/pghl-office-/);
    const calls = fakes.calls();
    expect(calls.find((c) => c.name === 'gridcraft-cli' && c.args[0] === 'cat')!.args.slice(2)).toEqual(['--csv', '--range', 'A1:B9', '--sheet', 'Umsatz']);
  });

  it('the agent edits a copy and the result is stored as a new version authored by the agent', async () => {
    const f = (await admin('POST', '/api/office/files', { kind: 'docx', name: 'Angebot' })).data;
    const me = t.app.services.agent.userFromRow(t.app.db.get('SELECT * FROM users WHERE email = ?', 'chef@example.com'));
    const out: any = await t.app.services.agent.runTool({ user: me, locationId: A, name: 'ghl_office_edit', args: { file_id: f.id, commands: [{ command: 'select.text', params: { text: 'Angebot' } }, { command: 'format.bold' }], message: 'Titel fett' }, allow: 'write' });
    expect(out).toMatchObject({ saved: true, version: 2 });
    const v = (await admin('GET', `/api/office/files/${f.id}/versions`)).data[0];
    expect(v).toMatchObject({ version: 2, author_kind: 'agent', author_name: 'KI-Agent (im Auftrag von Chef)', message: 'Titel fett' });
    expect(zipComment(current(f.id))).toBe('fake-edit select.text,format.bold');
    const call = fakes.calls().filter((c) => c.name === 'wordcraft-cli' && c.args[0] === 'run').at(-1)!;
    expect(call.args).toEqual(['run', '--file', `${call.cwd}/in.docx`, '--cmd', 'select.text={"text":"Angebot"}', '--cmd', 'format.bold={}', '--save', `${call.cwd}/out.docx`]);
    // a fresh temp folder per call, removed afterwards; no secrets of the server's environment
    expect(call.cwd).toMatch(/pghl-office-/);
    expect(call.env.filter((k) => k.startsWith('PGHL_') || /KEY|SECRET|TOKEN/.test(k))).toEqual([]);
  });

  it('writes ranges of a spreadsheet through a script file and exports a PDF as a new linked file', async () => {
    const c = (await admin('POST', '/api/contacts', { first_name: 'Paula', email: 'paula@example.com' })).data;
    const x = (await admin('POST', '/api/office/files', { kind: 'xlsx', name: 'Kalkulation', contact_id: c.id ?? c.contact?.id })).data;
    const e = await admin('POST', `/api/office/files/${x.id}/edit`, { writes: [{ range: 'A1:B2', values: [['Monat', 'Umsatz'], ['Jan', 100]] }], commands: [{ command: 'insert.chart', params: { range: 'A1:B2', type: 'column' } }] });
    expect(e.status, e.text).toBe(200);
    expect(zipComment(current(x.id))).toBe('fake-edit range.setValues,insert.chart');
    expect(e.data.version).toBe(2);
    const pdf = await admin('POST', `/api/office/files/${x.id}/export-pdf`, {});
    expect(pdf.data).toMatchObject({ kind: 'pdf', name: 'Kalkulation.pdf', contact_id: c.id ?? c.contact?.id, version: 1 });
    const call = fakes.calls().filter((c2) => c2.name === 'gridcraft-cli' && c2.args.some((a) => a.startsWith('file.exportPdf'))).at(-1)!;
    expect(call.args[4]).toBe(`file.exportPdf={"path":"${call.cwd}/out.pdf"}`);
    expect((await admin('POST', `/api/office/files/${pdf.data.id}/export-pdf`, {})).status).toBe(400);
    expect((await admin('POST', `/api/office/files/${x.id}/edit`, { writes: 'x' })).status).toBe(400);
    const doc = (await admin('POST', '/api/office/files', { kind: 'docx', name: 'Kein Blatt' })).data;
    expect((await admin('POST', `/api/office/files/${doc.id}/edit`, { writes: [{ range: 'A1', values: [[1]] }] })).data.error).toContain('nur bei Tabellen');
  });

  it('edits a PDF through a script confined to its folder', async () => {
    const p = (await admin('POST', '/api/office/files', { kind: 'pdf', name: 'Formular' })).data;
    const e = await admin('POST', `/api/office/files/${p.id}/edit`, { commands: [{ command: 'page_rotate', params: { pages: [1], degrees: 90 } }] });
    expect(e.status, e.text).toBe(200);
    expect(current(p.id).toString('latin1')).toContain('% fake-edit');
    const call = fakes.calls().filter((c) => c.name === 'pdfcraft-cli' && c.args[0] === 'run').at(-1)!;
    expect(call.args).toEqual(['run', '--script', `${call.cwd}/steps.json`, '--root', call.cwd]);
    expect((await admin('POST', `/api/office/files/${p.id}/edit`, { commands: [{ command: 'doc_open', params: {} }] })).status).toBe(400);
  });

  it('refuses commands that would touch other files, and reports engine errors without its temp paths', async () => {
    const f = (await admin('POST', '/api/office/files', { kind: 'docx', name: 'Sicher' })).data;
    const bad = await admin('POST', `/api/office/files/${f.id}/edit`, { commands: [{ command: 'insert.picture', params: { path: '/etc/passwd' } }] });
    expect(bad.status).toBe(400);
    expect((await admin('POST', `/api/office/files/${f.id}/edit`, { commands: [{ command: 'file.saveAs', params: {} }] })).status).toBe(400);
    expect((await admin('POST', `/api/office/files/${f.id}/edit`, { commands: [] })).status).toBe(400);
    const fail = await admin('POST', `/api/office/files/${f.id}/edit`, { commands: [{ command: 'fake.fail' }] });
    expect(fail.status).toBe(422);
    expect(fail.data.error).toContain('Befehl fake.fail: geht nicht in');
    expect(fail.data.error).not.toMatch(/pghl-office-/);
    const huge = await admin('POST', `/api/office/files/${f.id}/edit`, { commands: [{ command: 'fake.huge' }] });
    expect(huge.status).toBe(502);
    const before = ENGINE_LIMITS.timeoutMs;
    ENGINE_LIMITS.timeoutMs = 400;
    try {
      const slow = await admin('POST', `/api/office/files/${f.id}/edit`, { commands: [{ command: 'fake.sleep' }] });
      expect(slow.status).toBe(504);
    } finally {
      ENGINE_LIMITS.timeoutMs = before;
    }
    expect((await admin('GET', `/api/office/files/${f.id}`)).data.version).toBe(1);
  });

  it('respects the edit lock: an agent edit for somebody else is refused with who holds it', async () => {
    const f = (await admin('POST', '/api/office/files', { kind: 'docx', name: 'Gesperrt' })).data;
    await maria('POST', `/api/office/files/${f.id}/lock`);
    const r = await admin('POST', `/api/office/files/${f.id}/edit`, { commands: [{ command: 'format.bold' }] });
    expect(r.status).toBe(423);
    expect(r.data.error).toMatch(/^Maria Muster bearbeitet die Datei gerade/);
    const viaMcp = await mcp('ghl_office_edit', { location_id: A, file_id: f.id, commands: [{ command: 'format.bold' }] });
    expect(viaMcp.ok).toBe(false);
    expect(viaMcp.text).toContain('Maria Muster bearbeitet die Datei gerade');
    // Maria's own agent may edit her checked-out file
    const ok = await maria('POST', `/api/office/files/${f.id}/edit`, { commands: [{ command: 'format.bold' }] });
    expect(ok.status).toBe(200);
    expect(fakes.calls().filter((c) => c.args.includes('format.bold={}')).length).toBeGreaterThan(0);
  });

  it('turns a save in the presentation editor\'s own format into a new .pptx version', async () => {
    const p = (await admin('POST', '/api/office/files', { kind: 'pptx', name: 'Pitch' })).data;
    const native = blankFile('docx'); // any ZIP stands in for the editor's .deckcraft container
    const r = await fetch(`${t.base}/api/office/files/${p.id}/versions/convert?from=deckcraft&base_version=1`, { method: 'POST', headers: { cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': A, 'content-type': 'application/octet-stream' }, body: native });
    expect(r.status).toBe(200);
    expect((await r.json()).saved_version).toBe(2);
    expect(zipComment(current(p.id))).toBe('fake-edit convert');
    const call = fakes.calls().filter((c) => c.name === 'deckcraft-cli' && c.args[0] === 'convert').at(-1)!;
    expect(call.args).toEqual(['convert', `${call.cwd}/in.deckcraft`, `${call.cwd}/out.pptx`]);
    const doc = (await admin('POST', '/api/office/files', { kind: 'docx', name: 'Kein Foliensatz' })).data;
    expect((await admin('POST', `/api/office/files/${doc.id}/versions/convert`, { from: 'deckcraft', data: native.toString('base64') })).status).toBe(400);
    expect((await admin('POST', `/api/office/files/${p.id}/versions/convert`, { from: 'deckcraft', data: Buffer.from('kein zip').toString('base64') })).status).toBe(400);
  });

  it('MCP tools: list, create with commands, read, edit, export – audited, sub-account bound', async () => {
    const created = await mcp('ghl_office_create', { location_id: A, kind: 'xlsx', name: 'Budget 2027', rows: [['Posten', 'Betrag'], ['Miete', 1200]], commands: [{ command: 'cell.set', params: { cell: 'B3', input: '=SUMME(B2:B2)' } }] });
    expect(created.ok, created.text).toBe(true);
    expect(created.data).toMatchObject({ created: true, name: 'Budget 2027.xlsx', version: 2, link: `/app/office/${created.data.id}` });
    const list = await mcp('ghl_office_list', { location_id: A, kind: 'xlsx', query: 'Budget' });
    expect(list.data.files.map((f: any) => f.name)).toEqual(['Budget 2027.xlsx']);
    const read = await mcp('ghl_office_read', { location_id: A, file_id: created.data.id, mode: 'text' });
    expect(read.data.text).toBe('A,B\n1,2');
    const edit = await mcp('ghl_office_edit', { location_id: A, file_id: created.data.id, writes: [{ range: 'C1', values: [['Notiz']] }], base_version: 2 });
    expect(edit.data).toMatchObject({ saved: true, version: 3 });
    const stale = await mcp('ghl_office_edit', { location_id: A, file_id: created.data.id, writes: [{ range: 'C1', values: [['x']] }], base_version: 2 });
    expect(stale.ok).toBe(false);
    expect(stale.text).toContain('neuere Version');
    const pdf = await mcp('ghl_office_export_pdf', { location_id: A, file_id: created.data.id, name: 'Budget als PDF' });
    expect(pdf.data).toMatchObject({ kind: 'pdf', name: 'Budget als PDF.pdf' });
    const versions = (await admin('GET', `/api/office/files/${created.data.id}/versions`)).data;
    expect(versions.map((v: any) => v.author_kind)).toEqual(['bot', 'bot', 'bot']);
    expect(versions[0].author_name).toBe('API: Agent-Test');
    expect(t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE via = 'mcp' AND route LIKE '% /api/office/%'`)!.n).toBeGreaterThanOrEqual(4);
    const B = (await t.api.post('/api/locations', { name: 'Andere' })).data.id;
    const foreign = await mcp('ghl_office_read', { location_id: B, file_id: created.data.id });
    expect(foreign.ok).toBe(false);
    // starting rows reach the engine as a real spreadsheet
    expect(blankFile('xlsx', { rows: [['a']] }).length).toBeGreaterThan(100);
  });
});
