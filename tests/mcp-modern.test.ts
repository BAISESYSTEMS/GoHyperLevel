import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_SKILLS } from '../server/services/mcp-skills.js';
import { confirmAnswer, confirmRequest, needsWord } from '../server/services/mcp-ext.js';
import { startTestApp } from './helpers.js';

/**
 * MCP revision 2026-07-28 next to the legacy handshake: server/discover, per-request _meta, resultType, header checks,
 * Skills over MCP (built-in + wiki), confirmations through elicitation (input_required + requestState), Tasks for long tools
 * and File Uploads (upload_required → PUT → second call).
 */

type T = Awaited<ReturnType<typeof startTestApp>>;
let t: T;
let agencyKey = '';
let otherKey = '';
let locKey = '';
let A = '';

const V = '2026-07-28';
const meta = (caps: Record<string, unknown> = {}) => ({ 'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': caps });
const ELICIT = { elicitation: { form: {} } };
const TASKS = { extensions: { 'io.modelcontextprotocol/tasks': {} } };
const FILES = { extensions: { 'io.modelcontextprotocol/files': { upload: {} } } };

let seq = 0;
async function post(key: string, body: unknown, headers: Record<string, string> = {}, query = '') {
  const r = await fetch(`${t.base}/mcp${query}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
}
/** A modern request: version + capabilities in _meta, and the routing headers of the HTTP binding. */
async function modern(key: string, method: string, params: Record<string, unknown> = {}, caps: Record<string, unknown> = {}, query = '') {
  const name = (params.name ?? params.uri) as string | undefined;
  return post(key, { jsonrpc: '2.0', id: ++seq, method, params: { ...params, _meta: meta(caps) } }, { 'mcp-protocol-version': V, 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}) }, query);
}

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  A = (await t.api.post('/api/locations', { name: 'Modern GmbH' })).data.id;
  agencyKey = (await t.api.post('/api/agency/api-keys', { name: 'Modern' })).data.key;
  otherKey = (await t.api.post('/api/agency/api-keys', { name: 'Anderer' })).data.key;
  t.api.setLocation(A);
  locKey = (await t.api.post('/api/api-keys', { name: 'Modern A' })).data.key;
  // A long-running tool for the task tests (Tool.task).
  t.app.services.mcpTools = [
    ...(t.app.services.mcpTools ?? []),
    {
      name: 'ghl_test_slow',
      title: 'Langsamer Test',
      description: 'Testwerkzeug',
      inputSchema: { type: 'object', properties: { n: { type: 'integer' } }, required: [] },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      run: async (_c: unknown, a: any) => ({ mode: 'direct', n: a.n ?? 0 }),
      task: async (_c: unknown, a: any) => {
        await new Promise((r) => setTimeout(r, 150));
        return { mode: 'task', n: a.n ?? 0 };
      },
    },
  ];
});
afterAll(async () => {
  await t?.close();
});

describe('MCP 2026-07-28 basics', () => {
  it('answers server/discover with versions, extensions and server info', async () => {
    const r = await modern(agencyKey, 'server/discover');
    expect(r.status).toBe(200);
    const d = r.json.result;
    expect(d.resultType).toBe('complete');
    expect(d.supportedVersions).toContain(V);
    expect(d.supportedVersions).toContain('2025-06-18');
    expect(Object.keys(d.capabilities.extensions)).toEqual(['io.modelcontextprotocol/skills', 'io.modelcontextprotocol/tasks', 'io.modelcontextprotocol/files']);
    expect(d.capabilities.resources).toEqual({});
    expect(d._meta['io.modelcontextprotocol/serverInfo'].name).toBe('gohigh');
    expect(d.ttlMs).toBeGreaterThan(0);
  });

  it('rejects unknown versions, mismatching headers and unknown methods the modern way', async () => {
    const bad = await post(agencyKey, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe(-32022);
    expect(bad.json.error.data.supported).toContain(V);
    const mismatch = await post(agencyKey, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: meta() } }, { 'mcp-protocol-version': V, 'mcp-method': 'tools/call' });
    expect(mismatch.status).toBe(400);
    expect(mismatch.json.error.code).toBe(-32020);
    const name64 = await post(agencyKey, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ghl_list_projects', arguments: {}, _meta: meta() } }, { 'mcp-method': 'tools/call', 'mcp-name': `=?base64?${Buffer.from('ghl_list_projects').toString('base64')}?=` });
    expect(name64.status).toBe(200);
    const unknown = await modern(agencyKey, 'nope/nothing');
    expect(unknown.status).toBe(404);
    expect(unknown.json.error.code).toBe(-32601);
  });

  it('carries resultType and cache hints, and still speaks the legacy handshake', async () => {
    const list = (await modern(agencyKey, 'tools/list')).json.result;
    expect(list.resultType).toBe('complete');
    expect(list.ttlMs).toBe(300_000);
    expect(list.cacheScope).toBe('private');
    const call = (await modern(agencyKey, 'tools/call', { name: 'ghl_list_projects', arguments: {} })).json.result;
    expect(call.resultType).toBe('complete');
    expect(call.isError).toBe(false);
    const init = (await post(agencyKey, { jsonrpc: '2.0', id: 9, method: 'initialize', params: { protocolVersion: '2025-11-25' } })).json.result;
    expect(init.protocolVersion).toBe('2025-11-25');
    const legacy = (await post(agencyKey, { jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} })).json.result;
    expect(legacy.tools.length).toBeGreaterThan(200);
  });
});

describe('Skills over MCP', () => {
  it('lists the built-in skills with a manifest that matches the served bytes', async () => {
    const list = (await modern(agencyKey, 'skills/list')).json.result;
    expect(list.resultType).toBe('complete');
    const names = list.skills.map((s: any) => s.frontmatter.name);
    expect(names).toEqual(expect.arrayContaining(['hyperlevel-basics', 'hyperlevel-invoices', 'hyperlevel-deals', 'hyperlevel-appointments', 'hyperlevel-social-posts', 'hyperlevel-insights']));
    const basics = list.skills.find((s: any) => s.frontmatter.name === 'hyperlevel-basics');
    expect(basics.uri).toBe('skill://hyperlevel-basics/SKILL.md');
    const read = (await modern(agencyKey, 'resources/read', { uri: basics.uri })).json.result;
    const text = read.contents[0].text as string;
    expect(text.startsWith('---\nname: hyperlevel-basics\ndescription: ')).toBe(true);
    expect(basics.resources[0].size).toBe(Buffer.byteLength(text, 'utf8'));
    expect(basics.resources[0].digest).toBe(`sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`);
    const got = (await modern(agencyKey, 'skills/get', { uri: basics.uri })).json.result;
    expect(got.skill.frontmatter.name).toBe('hyperlevel-basics');
    expect((await modern(agencyKey, 'skills/get', { uri: 'skill://gibts-nicht/SKILL.md' })).json.error.code).toBe(-32602);
    expect((await modern(agencyKey, 'resources/read', { uri: 'file:///etc/passwd' })).json.error.code).toBe(-32602);
  });

  it('only names tools that exist', async () => {
    const all = new Set(((await post(agencyKey, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).json.result.tools as any[]).map((x) => x.name));
    all.add('ghl_search');
    all.add('ghl_execute');
    for (const s of BUILTIN_SKILLS) for (const name of s.files[0].text.match(/ghl_[a-z_]+/g) ?? []) expect(all.has(name), `${s.name}: ${name}`).toBe(true);
  });

  it('turns wiki pages of a space „Skills“ into skills (agency: prefixed with the sub-account)', async () => {
    const space = (await t.api.post('/api/wiki/spaces', { name: 'Skills' })).data;
    await t.api.post('/api/wiki/pages', { space_id: space.id, title: 'Angebot schreiben', body: 'So schreiben wir Angebote: immer mit Festpreis und 14 Tagen Gültigkeit.\n\n## Schritte\n1. Kontakt suchen' });
    const other = (await t.api.post('/api/wiki/spaces', { name: 'Allgemein' })).data;
    await t.api.post('/api/wiki/pages', { space_id: other.id, title: 'Kein Skill', body: 'Nur eine Notiz' });
    const own = (await modern(locKey, 'skills/list')).json.result.skills.map((s: any) => s.frontmatter.name);
    expect(own).toContain('angebot-schreiben');
    expect(own).not.toContain('kein-skill');
    const agency = (await modern(agencyKey, 'skills/list')).json.result.skills.find((s: any) => s.frontmatter.name === 'modern-gmbh-angebot-schreiben');
    expect(agency.frontmatter.description).toMatch(/Festpreis/);
    const text = (await modern(agencyKey, 'resources/read', { uri: agency.uri })).json.result.contents[0].text;
    expect(text).toMatch(/## Schritte/);
  });
});

describe('confirmation before sensitive tools (elicitation)', () => {
  const upload = async (path: string) => {
    const r = await modern(agencyKey, 'tools/call', { name: 'ghl_upload_files', arguments: { location_id: A, files: [{ path, content: 'hallo' }] } });
    expect(r.json.result.isError).toBe(false);
    return t.app.db.get<any>('SELECT id FROM project_files WHERE location_id = ? AND path = ?', A, path)!.id as string;
  };
  const exists = (id: string) => !!t.app.db.get('SELECT 1 AS x FROM project_files WHERE id = ?', id);

  it('asks first, runs only with the typed word and the untouched requestState', async () => {
    const fid = await upload('weg/a.txt');
    const args = { location_id: A, id: fid };
    const first = (await modern(agencyKey, 'tools/call', { name: 'ghl_delete_file', arguments: args }, ELICIT)).json.result;
    expect(first.resultType).toBe('input_required');
    const ask = first.inputRequests.confirm;
    expect(ask.method).toBe('elicitation/create');
    expect(ask.params.requestedSchema.properties.confirm.type).toBe('string');
    expect(ask.params.message).toMatch(/Projektdatei löschen/);
    expect(exists(fid)).toBe(true);

    const wrong = (await modern(agencyKey, 'tools/call', { name: 'ghl_delete_file', arguments: args, inputResponses: { confirm: { action: 'accept', content: { confirm: 'ja' } } }, requestState: first.requestState }, ELICIT)).json.result;
    expect(wrong.isError).toBe(true);
    expect(exists(fid)).toBe(true);
    const declined = (await modern(agencyKey, 'tools/call', { name: 'ghl_delete_file', arguments: args, inputResponses: { confirm: { action: 'decline' } }, requestState: first.requestState }, ELICIT)).json.result;
    expect(declined.isError).toBe(true);
    // Another id, other key or a changed state: asked again, nothing deleted.
    const yes = { confirm: { action: 'accept', content: { confirm: 'LÖSCHEN' } } };
    const otherArgs = (await modern(agencyKey, 'tools/call', { name: 'ghl_delete_file', arguments: { ...args, id: 'x' }, inputResponses: yes, requestState: first.requestState }, ELICIT)).json.result;
    expect(otherArgs.resultType).toBe('input_required');
    const otherCaller = (await modern(otherKey, 'tools/call', { name: 'ghl_delete_file', arguments: args, inputResponses: yes, requestState: first.requestState }, ELICIT)).json.result;
    expect(otherCaller.resultType).toBe('input_required');
    const tampered = (await modern(agencyKey, 'tools/call', { name: 'ghl_delete_file', arguments: args, inputResponses: yes, requestState: `${first.requestState}x` }, ELICIT)).json.result;
    expect(tampered.resultType).toBe('input_required');
    expect(exists(fid)).toBe(true);

    const ok = (await modern(agencyKey, 'tools/call', { name: 'ghl_delete_file', arguments: args, inputResponses: { confirm: { action: 'accept', content: { confirm: 'loeschen' } } }, requestState: first.requestState }, ELICIT)).json.result;
    expect(ok.resultType).toBe('complete');
    expect(ok.isError).toBe(false);
    expect(exists(fid)).toBe(false);
  });

  it('also guards tools run through ghl_execute; clients without elicitation run as before', async () => {
    const fid = await upload('weg/b.txt');
    const viaExecute = (await modern(agencyKey, 'tools/call', { name: 'ghl_execute', arguments: { tool: 'ghl_delete_file', arguments: { location_id: A, id: fid } } }, ELICIT, '?tools=compact')).json.result;
    expect(viaExecute.resultType).toBe('input_required');
    expect(exists(fid)).toBe(true);
    const noElicit = (await modern(agencyKey, 'tools/call', { name: 'ghl_delete_file', arguments: { location_id: A, id: fid } })).json.result;
    expect(noElicit.isError).toBe(false);
    expect(exists(fid)).toBe(false);
    const fid2 = await upload('weg/c.txt');
    const legacy = (await post(agencyKey, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ghl_delete_file', arguments: { location_id: A, id: fid2 } } })).json.result;
    expect(legacy.isError).toBe(false);
    expect(exists(fid2)).toBe(false);
  });

  it('builds tick or typed-word forms and reads the answers', () => {
    expect(needsWord('ghl_delete_file')).toBe(true);
    expect(needsWord('ghl_send_message')).toBe(false);
    const tick = confirmRequest({ name: 'ghl_send_message', title: 'Nachricht senden' }, { channel: 'email', body: 'x'.repeat(200), api_key: 'geheim' });
    expect(tick.params.requestedSchema.properties.confirm.type).toBe('boolean');
    expect(tick.params.message).not.toMatch(/geheim/);
    expect(tick.params.message).toMatch(/…/);
    expect(confirmAnswer('ghl_send_message', { confirm: { action: 'accept', content: { confirm: true } } })).toBe('yes');
    expect(confirmAnswer('ghl_send_message', { confirm: { action: 'accept', content: { confirm: false } } })).toBe('no');
    expect(confirmAnswer('ghl_send_message', { confirm: { action: 'cancel' } })).toBe('no');
    expect(confirmAnswer('ghl_send_message', {})).toBe('missing');
  });
});

describe('Tasks for long-running tools', () => {
  it('returns a task handle to clients that declare Tasks, and the result once done', async () => {
    const created = (await modern(agencyKey, 'tools/call', { name: 'ghl_test_slow', arguments: { n: 7 } }, TASKS)).json.result;
    expect(created.resultType).toBe('task');
    expect(created.status).toBe('working');
    expect(created.pollIntervalMs).toBeGreaterThan(0);
    expect(t.app.db.get('SELECT status FROM mcp_tasks WHERE id = ?', created.taskId)).toBeTruthy();
    let task: any;
    for (let i = 0; i < 40; i++) {
      task = (await modern(agencyKey, 'tasks/get', { taskId: created.taskId }, TASKS)).json.result;
      if (task.status !== 'working') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(task.resultType).toBe('complete');
    expect(task.status).toBe('completed');
    expect(task.result.structuredContent).toEqual({ mode: 'task', n: 7 });
    expect(task.result.resultType).toBe('complete');
    // Only the caller who started it sees it.
    expect((await modern(otherKey, 'tasks/get', { taskId: created.taskId }, TASKS)).json.error.code).toBe(-32602);
  });

  it('runs directly without the extension, and can cancel', async () => {
    const direct = (await modern(agencyKey, 'tools/call', { name: 'ghl_test_slow', arguments: { n: 1 } })).json.result;
    expect(direct.structuredContent).toEqual({ mode: 'direct', n: 1 });
    const created = (await modern(agencyKey, 'tools/call', { name: 'ghl_test_slow', arguments: { n: 2 } }, TASKS)).json.result;
    expect((await modern(agencyKey, 'tasks/cancel', { taskId: created.taskId }, TASKS)).json.result.resultType).toBe('complete');
    await new Promise((r) => setTimeout(r, 250));
    expect((await modern(agencyKey, 'tasks/get', { taskId: created.taskId }, TASKS)).json.result.status).toBe('cancelled');
  });

  it('marks the media tools and the migration as tasks', async () => {
    const all = (t.app.services.mcpTools as any[]).filter((x) => typeof x.task === 'function').map((x) => x.name);
    expect(all).toEqual(expect.arrayContaining(['ghl_generate_image', 'ghl_generate_video', 'ghl_generate_audio', 'ghl_transcribe', 'ghl_umzug_start']));
  });
});

describe('File Uploads', () => {
  const bytes = Buffer.from('%PDF-1.4 Testbeleg\n');
  const digest = createHash('sha256').update(bytes).digest('base64url');
  const file = (id = 'file-1') => ({ id, name: 'beleg.pdf', mimeType: 'application/pdf', size: bytes.length, digest: { algorithm: 'sha-256', value: digest } });

  it('asks for the bytes, takes them by PUT and saves the file on the second call', async () => {
    const args = { location_id: A, file: file(), path: 'belege/beleg.pdf' };
    const first = (await modern(agencyKey, 'tools/call', { name: 'ghl_upload_file', arguments: args }, FILES)).json.result;
    expect(first.resultType).toBe('upload_required');
    expect(first.content).toEqual([]);
    const target = first.uploads[0];
    expect(target.fileId).toBe('file-1');
    expect(target.credentials).toBe('include');
    expect(t.app.db.get('SELECT 1 AS x FROM project_files WHERE path = ?', 'belege/beleg.pdf')).toBeUndefined();

    const url = new URL(target.url);
    const put = (key: string, body: Buffer) => fetch(`${t.base}${url.pathname}`, { method: 'PUT', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/octet-stream' }, body });
    expect((await put(otherKey, bytes)).status).toBe(404);
    expect((await put(agencyKey, Buffer.from('zu kurz'))).status).toBe(400);
    expect((await put(agencyKey, bytes)).status).toBe(201);
    expect((await put(agencyKey, bytes)).status).toBe(409);

    const changed = await modern(agencyKey, 'tools/call', { name: 'ghl_upload_file', arguments: { ...args, path: 'anders.pdf' }, requestState: first.requestState }, FILES);
    expect(changed.json.error.code).toBe(-32602);
    const second = (await modern(agencyKey, 'tools/call', { name: 'ghl_upload_file', arguments: args, requestState: first.requestState }, FILES)).json.result;
    expect(second.isError).toBe(false);
    const row = t.app.db.get<any>('SELECT data, mime FROM project_files WHERE location_id = ? AND path = ?', A, 'belege/beleg.pdf');
    expect(Buffer.from(row.data).equals(bytes)).toBe(true);
    expect(row.mime).toBe('application/pdf');
    expect((await modern(agencyKey, 'tools/call', { name: 'ghl_upload_file', arguments: args, requestState: first.requestState }, FILES)).json.error.code).toBe(-32602);
  });

  it('refuses without the extension (bare -32021), accepts inline data, checks the digest', async () => {
    const no = await modern(agencyKey, 'tools/call', { name: 'ghl_upload_file', arguments: { location_id: A, file: file() } });
    expect(no.status).toBe(400);
    expect(no.json.jsonrpc).toBeUndefined();
    expect(no.json.error.code).toBe(-32021);
    expect(no.json.error.data.requiredCapabilities.extensions['io.modelcontextprotocol/files']).toEqual({ upload: {} });
    const inline = (await modern(agencyKey, 'tools/call', { name: 'ghl_upload_file', arguments: { location_id: A, file: { ...file(), data: bytes.toString('base64') }, path: 'inline.pdf' } })).json.result;
    expect(inline.isError).toBe(false);

    const args = { location_id: A, file: { ...file('f2'), digest: { algorithm: 'sha-256', value: 'falsch' } }, path: 'falsch.pdf' };
    const first = (await modern(agencyKey, 'tools/call', { name: 'ghl_upload_file', arguments: args }, FILES)).json.result;
    await fetch(`${t.base}${new URL(first.uploads[0].url).pathname}`, { method: 'PUT', headers: { authorization: `Bearer ${agencyKey}` }, body: bytes });
    const second = (await modern(agencyKey, 'tools/call', { name: 'ghl_upload_file', arguments: args, requestState: first.requestState }, FILES)).json.result;
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toMatch(/Prüfsumme/);
  });
});
