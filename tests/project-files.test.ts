import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { cleanPath, guessMime } from '../server/modules/project-files.js';
import { MCP_API_DENY, apiPath } from '../server/modules/mcp-api.js';

/** Project files, moving claude.ai projects over and ghl_api (modules/project-files.ts, claude-import.ts, mcp-api.ts). */

type T = Awaited<ReturnType<typeof startTestApp>>;
let t: T;
let A = '';
let B = '';
let agencyKey = '';
let readKey = '';
let keyA = '';

async function rpc(key: string, name: string, args: unknown) {
  const r = await fetch(`${t.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const j: any = await r.json();
  const text: string = j.error ? `RPC ${j.error.code} ${j.error.message}` : (j.result?.content?.[0]?.text ?? '');
  return { ok: !!j.result && !j.result.isError, text, data: j.result?.structuredContent ?? (j.result && !j.result.isError ? JSON.parse(text) : null) };
}
const listTools = async (key: string) => {
  const r = await fetch(`${t.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  return ((await r.json()) as any).result.tools.map((x: any) => x.name) as string[];
};

beforeAll(async () => {
  t = await startTestApp();
  const me = await t.setup();
  A = me.locations[0].id;
  B = (await t.api.post('/api/locations', { name: 'Zweitfirma' })).data.id;
  agencyKey = (await t.api.post('/api/agency/api-keys', { name: 'Claude' })).data.key;
  readKey = (await t.api.post('/api/agency/api-keys', { name: 'Lesen', scope: 'read' })).data.key;
  t.api.setLocation(A);
  keyA = (await t.api.post('/api/api-keys', { name: 'Nur A' })).data.key;
});
afterAll(async () => {
  delete process.env.PGHL_PROJECT_FILES_MB;
  await t.close();
});

describe('project files (REST)', () => {
  it('uploads text and binary, lists, reads, downloads as attachment and deletes', async () => {
    t.api.setLocation(A);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
    const up = await t.api.post('/api/project-files', {
      source: 'claude-code',
      files: [
        { path: './docs/plan.md', content: '# Plan\nÄrger vermeiden' },
        { path: 'img/logo.png', data: png.toString('base64') },
        { path: 'site/index.html', content: '<script>alert(1)</script>' },
      ],
    });
    expect(up.status, JSON.stringify(up.data)).toBe(200);
    expect(up.data).toMatchObject({ created: 3, updated: 0, unchanged: 0 });
    expect(up.data.files.map((f: any) => f.path)).toEqual(['docs/plan.md', 'img/logo.png', 'site/index.html']);

    const list = await t.api.get('/api/project-files');
    expect(list.data.total).toBe(3);
    expect(list.data.files.map((f: any) => f.path)).toEqual(['docs/plan.md', 'img/logo.png', 'site/index.html']);
    expect(list.data.files[0]).toMatchObject({ mime: 'text/markdown', source: 'claude-code', size: Buffer.byteLength('# Plan\nÄrger vermeiden') });
    expect(list.data.files[0].data).toBeUndefined();
    expect((await t.api.get('/api/project-files?prefix=img/')).data.files.map((f: any) => f.path)).toEqual(['img/logo.png']);
    // LIKE wildcards in the prefix are literal
    expect((await t.api.get('/api/project-files?prefix=%25')).data.files).toEqual([]);

    const md = list.data.files[0];
    const one = await t.api.get(`/api/project-files/${md.id}`);
    expect(one.data).toMatchObject({ path: 'docs/plan.md', text: true, content: '# Plan\nÄrger vermeiden' });
    const bin = await t.api.get(`/api/project-files/${list.data.files[1].id}`);
    expect(bin.data).toMatchObject({ mime: 'image/png', text: false, content: null });

    const raw = await t.api.raw(`/api/project-files/${list.data.files[1].id}/raw`, { headers: { cookie: t.api.cookie, 'x-location-id': A } });
    expect(raw.status).toBe(200);
    expect(Buffer.from(await raw.arrayBuffer()).equals(png)).toBe(true);
    expect(raw.headers.get('content-disposition')).toMatch(/^attachment; filename="logo.png"/);
    expect(raw.headers.get('x-content-type-options')).toBe('nosniff');
    expect(raw.headers.get('content-security-policy')).toContain('sandbox');
    // markup is never served as something a browser would render
    const html = await t.api.raw(`/api/project-files/${list.data.files[2].id}/raw`, { headers: { cookie: t.api.cookie, 'x-location-id': A } });
    expect(html.headers.get('content-type')).toBe('application/octet-stream');
    expect(html.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(t.app.db.get(`SELECT COUNT(*) n FROM audit_log WHERE action = 'export:project-files'`)!.n).toBe(2);

    // the same bytes again: nothing changes; new bytes: updated in place
    const again = await t.api.post('/api/project-files', { files: [{ path: 'docs/plan.md', content: '# Plan\nÄrger vermeiden' }, { path: 'site/index.html', content: 'neu' }] });
    expect(again.data).toMatchObject({ created: 0, updated: 1, unchanged: 1 });
    expect(again.data.files[0].id).toBe(md.id);

    expect((await t.api.del(`/api/project-files/${md.id}`)).status).toBe(200);
    expect((await t.api.get(`/api/project-files/${md.id}`)).status).toBe(404);
    expect(t.app.db.get(`SELECT COUNT(*) n FROM audit_log WHERE route = 'DELETE /api/project-files/:id'`)!.n).toBe(1);
  });

  it('rejects path traversal and other bad paths', async () => {
    t.api.setLocation(A);
    for (const path of ['../x', 'a/../../etc/passwd', 'a/./b', '..\\..\\win.ini', 'C:/Windows/x', 'a//', '', 'x\u0000y', 'a'.repeat(501)]) {
      const r = await t.api.post('/api/project-files', { files: [{ path, content: 'x' }] });
      expect(r.status, path).toBe(400);
    }
    expect(cleanPath('/repo//src\\main.ts')).toBe('repo/src/main.ts');
    expect(() => cleanPath('src/../../x')).toThrow(/ungültig/);
    expect(guessMime('src/app.tsx', false)).toBe('text/plain');
    expect(guessMime('blob', false)).toBe('application/octet-stream');
    // a batch is all or nothing
    const r = await t.api.post('/api/project-files', { files: [{ path: 'ok.txt', content: 'x' }, { path: '../bad', content: 'x' }] });
    expect(r.status).toBe(400);
    expect((await t.api.get('/api/project-files?prefix=ok.txt')).data.files).toEqual([]);
    expect((await t.api.post('/api/project-files', { files: [{ path: 'a.txt', content: 'x', data: 'eA==' }] })).status).toBe(400);
    expect((await t.api.post('/api/project-files', { files: [{ path: 'a.txt', content: 'x' }, { path: './a.txt', content: 'y' }] })).status).toBe(400);
    expect((await t.api.post('/api/project-files', { files: [{ path: 'a.bin', data: '!!!' }] })).status).toBe(400);
    expect((await t.api.post('/api/project-files', { files: [{ path: 'a.txt', content: 'x', mime: 'text html' }] })).status).toBe(400);
  });

  it('enforces the limits per file, per batch and per sub-account', async () => {
    t.api.setLocation(A);
    const big = 'x'.repeat(10 * 1024 * 1024 + 1);
    expect((await t.api.post('/api/project-files', { files: [{ path: 'big.txt', content: big }] })).status).toBe(413);
    const many = Array.from({ length: 201 }, (_, i) => ({ path: `f/${i}.txt`, content: 'x' }));
    expect((await t.api.post('/api/project-files', { files: many })).status).toBe(413);
    const nine = 'y'.repeat(9 * 1024 * 1024);
    const batch = await t.api.post('/api/project-files', { files: [1, 2, 3].map((i) => ({ path: `n/${i}.txt`, content: nine })) });
    expect(batch.status).toBe(413);
    expect(batch.data.error).toMatch(/25 MB/);
    process.env.PGHL_PROJECT_FILES_MB = '1';
    try {
      const full = await t.api.post('/api/project-files', { files: [{ path: 'q.txt', content: 'z'.repeat(1024 * 1024 + 10) }] });
      expect(full.status).toBe(413);
      expect(full.data.error).toMatch(/PGHL_PROJECT_FILES_MB/);
    } finally {
      delete process.env.PGHL_PROJECT_FILES_MB;
    }
  });

  it('keeps sub-accounts apart', async () => {
    t.api.setLocation(A);
    const up = await t.api.post('/api/project-files', { files: [{ path: 'geheim.md', content: 'nur A' }] });
    const fid = up.data.files[0].id;
    t.api.setLocation(B);
    expect((await t.api.get(`/api/project-files/${fid}`)).status).toBe(404);
    expect((await t.api.raw(`/api/project-files/${fid}/raw`, { headers: { cookie: t.api.cookie, 'x-location-id': B } })).status).toBe(404);
    expect((await t.api.del(`/api/project-files/${fid}`)).status).toBe(404);
    expect((await t.api.get('/api/project-files')).data.files).toEqual([]);
    // same path in B is a file of its own
    expect((await t.api.post('/api/project-files', { files: [{ path: 'geheim.md', content: 'B' }] })).data.created).toBe(1);
    // a key for A cannot reach the file through MCP with B's id, nor point at B
    const other = t.app.db.get<{ id: string }>('SELECT id FROM project_files WHERE location_id = ? AND path = ?', B, 'geheim.md')!.id;
    const r = await rpc(keyA, 'ghl_read_file', { id: other });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('404');
    const r2 = await rpc(keyA, 'ghl_list_files', { location_id: B });
    expect(r2.text).toMatch(/403.*nur für einen Sub-Account/);
    // deleting the sub-account takes its files along
    t.api.setLocation(A);
    expect((await t.api.del(`/api/locations/${B}`)).status).toBe(200);
    expect(t.app.db.get('SELECT COUNT(*) n FROM project_files WHERE location_id = ?', B)!.n).toBe(0);
    B = (await t.api.post('/api/locations', { name: 'Zweitfirma' })).data.id;
  });
});

describe('MCP: file tools and ghl_import_claude_project', () => {
  it('uploads, lists, reads and deletes through MCP', async () => {
    const up = await rpc(agencyKey, 'ghl_upload_files', { location_id: A, source: 'claude-code', files: [{ path: 'repo/README.md', content: 'Hallo' }] });
    expect(up.ok, up.text).toBe(true);
    const list = await rpc(agencyKey, 'ghl_list_files', { location_id: A, prefix: 'repo/' });
    expect(list.data.files).toHaveLength(1);
    const read = await rpc(readKey, 'ghl_read_file', { location_id: A, id: list.data.files[0].id });
    expect(read.data).toMatchObject({ path: 'repo/README.md', content: 'Hallo', source: 'claude-code' });
    expect((await rpc(readKey, 'ghl_upload_files', { location_id: A, files: [{ path: 'x.md', content: 'x' }] })).text).toContain('darf nur lesen');
    const del = await rpc(agencyKey, 'ghl_delete_file', { location_id: A, id: list.data.files[0].id });
    expect(del.ok).toBe(true);
    expect(t.app.db.get(`SELECT COUNT(*) n FROM audit_log WHERE via = 'mcp' AND route LIKE '% /api/project-files%'`)!.n).toBeGreaterThanOrEqual(2);
  });

  it('imports a claude.ai project once – a second run changes nothing', async () => {
    const input = {
      name: 'Kunde Mustermann',
      instructions: 'Antworte immer auf Deutsch.',
      description: 'Website-Relaunch',
      files: [
        { path: 'wissen/briefing.md', content: '# Briefing' },
        { path: 'wissen/logo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') },
      ],
      links: [
        { url: 'https://claude.ai/chat/abc-123', title: 'Kickoff', kind: 'chat' },
        { url: 'https://claude.ai/artifact/xyz', title: 'Sitemap' },
      ],
    };
    const first = await rpc(agencyKey, 'ghl_import_claude_project', input);
    expect(first.ok, first.text).toBe(true);
    expect(first.data).toMatchObject({ created_project: true, instructions_file: 'CLAUDE.md', files: { created: 3, updated: 0, unchanged: 0 }, links: { created: 2, updated: 0 } });
    expect(first.data.profile_updated.sort()).toEqual(['description', 'notes']);
    const loc = first.data.location_id;
    t.api.setLocation(loc);
    const project = (await t.api.get('/api/project')).data;
    expect(project).toMatchObject({ notes: 'Antworte immer auf Deutsch.', description: 'Website-Relaunch' });
    const files = (await t.api.get('/api/project-files')).data.files;
    expect(files.map((f: any) => f.path)).toEqual(['CLAUDE.md', 'wissen/briefing.md', 'wissen/logo.png']);
    expect(files.every((f: any) => f.source === 'claude-project')).toBe(true);
    const docs = (await t.api.get('/api/docs')).data;
    expect(docs.map((d: any) => [d.title, d.kind]).sort()).toEqual([['Kickoff', 'session'], ['Sitemap', 'artifact']]);

    const second = await rpc(agencyKey, 'ghl_import_claude_project', input);
    expect(second.ok, second.text).toBe(true);
    expect(second.data).toMatchObject({ location_id: loc, created_project: false, profile_updated: [], files: { created: 0, updated: 0, unchanged: 3 }, links: { created: 0 } });
    expect(t.app.db.get('SELECT COUNT(*) n FROM locations WHERE name = ?', 'Kunde Mustermann')!.n).toBe(1);
    expect(t.app.db.get('SELECT COUNT(*) n FROM docs WHERE location_id = ?', loc)!.n).toBe(2);

    // own notes are never overwritten; new instructions update the file
    await t.api.put('/api/project', { notes: 'Eigene Notiz' });
    const third = await rpc(agencyKey, 'ghl_import_claude_project', { ...input, instructions: 'Neu: Sie-Form.' });
    expect(third.data.profile_updated).toEqual([]);
    expect(third.data.files).toMatchObject({ updated: 1, unchanged: 2 });
    expect((await t.api.get('/api/project')).data.notes).toBe('Eigene Notiz');

    // only agency connections see the tool
    expect(await listTools(agencyKey)).toContain('ghl_import_claude_project');
    expect(await listTools(keyA)).not.toContain('ghl_import_claude_project');
    expect(await listTools(keyA)).toEqual(expect.arrayContaining(['ghl_upload_files', 'ghl_list_files', 'ghl_read_file', 'ghl_delete_file', 'ghl_api']));
  });

  it('imports into a given location_id and refuses an unknown one', async () => {
    const r = await rpc(agencyKey, 'ghl_import_claude_project', { name: 'egal', location_id: A, instructions: 'X' });
    expect(r.data).toMatchObject({ location_id: A, created_project: false });
    const bad = await rpc(agencyKey, 'ghl_import_claude_project', { name: 'egal', location_id: 'gibtsnicht' });
    expect(bad.text).toContain('(404)');
  });
});

describe('ghl_api', () => {
  it('denies sign-in, people, keys, tokens, sessions, OAuth and backups – also with path tricks', () => {
    const denied = [
      '/api/auth/login',
      '/api/auth/magic-link',
      '/api/admin/backup',
      '/api/admin/backups/x.db',
      '/api/admin/offsite-backup/run',
      '/api/me/password',
      '/api/me/2fa/disable',
      '/api/me/passkeys',
      '/api/me/sessions/revoke-others',
      '/api/users',
      '/api/users/u1/2fa/reset',
      '/api/api-keys',
      '/api/agency/api-keys',
      '/api/agency/ai-tools/keys',
      '/api/agent/gpt-actions/keys',
      '/api/oauth/start',
      '/api/agency/oauth',
      '/api/mcp-oauth/requests/r1/approve',
      '/api/mcp-servers/m1/oauth/start',
      '/api/agency/login/invites',
      '/api/agency/sso',
      '/api/mobile/pair',
      '/api/push/devices/1',
      '/api/demo/login',
      '/api/cloud/team/u1/invite',
      '/api/affiliates/a1/login-link',
      '/api/inbound-webhooks/w1/secret',
      '/api/helpdesk/settings/rotate-key',
      // tricks
      '/api//users',
      '/api/contacts/../auth/login',
      '/api/contacts/%2e%2e/users',
      '/api/USERS',
      '/api/%61uth/login',
      '/api/me%2Fpassword',
      '/api/users?x=1',
    ];
    for (const p of denied) expect(() => apiPath(p), p).toThrow(/gesperrt/);
    for (const p of ['https://evil.example/api/contacts', '//evil.example/api/x', 'api/contacts', '/apix', '/hooks/x', '/api\\..\\auth', '']) expect(() => apiPath(p), p).toThrow(/path/);
    expect(apiPath('/api/contacts?limit=5')).toBe('/api/contacts?limit=5');
    expect(apiPath('/api/contacts/./x/../')).toBe('/api/contacts');
    expect(MCP_API_DENY.length).toBeGreaterThan(10);
  });

  it("runs with the caller's own scope, never more", async () => {
    // agency: location routes need location_id
    const contacts = await rpc(agencyKey, 'ghl_api', { method: 'POST', path: '/api/contacts', location_id: A, body: { first_name: 'Api', email: 'api@example.com' } });
    expect(contacts.ok, contacts.text).toBe(true);
    const list = await rpc(agencyKey, 'ghl_api', { method: 'GET', path: '/api/contacts?q=api@example.com', location_id: A });
    expect(list.data.contacts[0].email).toBe('api@example.com');
    expect((await rpc(agencyKey, 'ghl_api', { method: 'GET', path: '/api/contacts' })).text).toContain('location_id fehlt');
    expect((await rpc(agencyKey, 'ghl_api', { method: 'GET', path: '/api/agency/projects' })).ok).toBe(true);
    // denied routes
    const users = await rpc(agencyKey, 'ghl_api', { method: 'GET', path: '/api/users' });
    expect(users.text).toMatch(/\(403\).*gesperrt/);
    const keys = await rpc(agencyKey, 'ghl_api', { method: 'POST', path: '/api/agency/api-keys', body: { name: 'mehr' } });
    expect(keys.ok).toBe(false);
    expect(t.app.db.get('SELECT COUNT(*) n FROM agency_api_keys')!.n).toBe(2);
    // read-only stays read-only
    expect((await rpc(readKey, 'ghl_api', { method: 'GET', path: '/api/contacts', location_id: A })).ok).toBe(true);
    expect((await rpc(readKey, 'ghl_api', { method: 'POST', path: '/api/tasks', location_id: A, body: { title: 'nein' } })).text).toContain('darf nur lesen');
    // a sub-account key stays in its sub-account and off agency routes
    expect((await rpc(keyA, 'ghl_api', { method: 'GET', path: '/api/contacts' })).ok).toBe(true);
    expect((await rpc(keyA, 'ghl_api', { method: 'GET', path: '/api/contacts', location_id: B })).text).toMatch(/403.*nur für einen Sub-Account/);
    const agencyRoute = await rpc(keyA, 'ghl_api', { method: 'GET', path: '/api/agency/projects' });
    expect(agencyRoute.ok).toBe(false);
    expect(agencyRoute.text).toMatch(/\((401|403)\)/);
    expect((await rpc(agencyKey, 'ghl_api', { method: 'TRACE', path: '/api/contacts' })).ok).toBe(false);
  });
  it('key guards see one spelling of a path (no // or trailing-slash bypass)', async () => {
    for (const path of ['/api/users', '/api//users', '//api/users', '/api/users/']) {
      const get = await fetch(`${t.base}${path}`, { headers: { authorization: `Bearer ${agencyKey}` } });
      expect(get.status, `GET ${path}`).toBe(403);
      const post = await fetch(`${t.base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${agencyKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x@example.com', password: 'passwort-1' }) });
      expect(post.status, `POST ${path}`).toBe(403);
    }
  });
});
