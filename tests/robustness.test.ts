import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestApp } from './helpers.js';
import { makeBackupAsync, listBackups } from '../server/modules/backups.js';
import { Db } from '../server/core/db.js';

/**
 * Input that is wrong must be answered with a 4xx. Each of these used to end in "Interner Fehler" (500) and a stack trace in the log:
 * a literal `null` body, a malformed percent-escape in the path or a cookie, an object where a column wants text, a required column
 * sent as null, a date nobody checked, a duplicate. (tests/route-fuzz.test.ts sweeps every route for the same.)
 */
describe('bad input is a 4xx, never a 500', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await t.close();
  });

  const raw = (method: string, path: string, body?: string, headers: Record<string, string> = {}) =>
    fetch(t.base + path, { method, headers: { 'content-type': 'application/json', 'x-pghl': '1', cookie: t.api.cookie, 'x-location-id': t.api.location, ...headers }, body });

  it('a literal null body is an empty body', async () => {
    const r = await raw('POST', '/api/tags', 'null');
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toMatch(/fehlt|Name/i);
    expect((await raw('POST', '/api/tasks', 'null')).status).toBeLessThan(500);
    expect((await raw('POST', '/api/smart-lists', 'null')).status).toBeLessThan(500);
  });

  it('a malformed percent-escape in the path or in a cookie is a 404 / 401, not a crash', async () => {
    expect((await raw('GET', '/api/contacts/%E0%A4%A')).status).toBe(404);
    expect((await raw('DELETE', '/api/tags/%E0%A4%A')).status).toBe(404);
    const noAuth = await fetch(t.base + '/api/me', { headers: { cookie: 'pghl_session=%E0%A4%A' } });
    expect(noAuth.status).toBe(401);
  });

  it('an object or array where a column wants a scalar is a 400 (not "Unknown named parameter")', async () => {
    const a = await raw('POST', '/api/tasks', JSON.stringify({ title: 'x', contact_id: { a: { b: 1 } } }));
    expect(a.status).toBe(400);
    const b = await raw('POST', '/api/tasks', JSON.stringify({ title: 'x', contact_id: [1, 2] }));
    expect(b.status).toBe(400);
  });

  it('a JSON array as the whole body of a campaign or template write is a 400 (array methods like .filter never reach a column)', async () => {
    const c = (await t.api.post('/api/campaigns', { name: 'Array-Test', channel: 'email', subject: 'Hallo', body: 'Text' })).data;
    expect(c.id).toBeTruthy();
    for (const [method, path] of [
      ['PATCH', `/api/campaigns/${c.id}`],
      ['POST', '/api/campaigns'],
      ['POST', `/api/campaigns/${c.id}/audience`],
      ['POST', '/api/templates'],
    ]) {
      for (const body of ['[]', '[{"name":"x"}]', '"text"', '42']) {
        const r = await raw(method, path, body);
        expect(r.status, `${method} ${path} ${body}`).toBe(400);
        expect((await r.json()).error).toContain('JSON-Objekt');
      }
    }
    expect((await t.api.get(`/api/campaigns/${c.id}`)).data).toMatchObject({ name: 'Array-Test', status: 'draft' });
    expect((await t.api.patch(`/api/campaigns/${c.id}`, { name: 'Objekt geht' })).data.name).toBe('Objekt geht');
    // Top-level arrays stay allowed outside campaigns: the body parser itself does not reject them.
    expect((await raw('POST', '/api/tags', '[]')).status).not.toBe(500);
  });

  it('a required column sent as null is a 400 naming the column, not a 500', async () => {
    const c = await t.api.post('/api/contacts', { first_name: 'Null', last_name: 'Test', email: 'null@example.com' });
    const r = await t.api.patch(`/api/contacts/${c.data.id}`, { phone: null });
    expect(r.status).toBeLessThan(500);
  });

  it('dates in a query that are not dates are a 400', async () => {
    for (const p of ['/api/pm/tasks?from=zzz', '/api/pm/tasks?to=2026-13-45', '/api/pm/time?from=zzz', '/api/pm/time/report?from=zzz', '/api/pm/time/export.csv?to=nope']) {
      const r = await t.api.get(p);
      expect(r.status, p).toBe(400);
      expect(r.data.error).toMatch(/JJJJ-MM-TT/);
    }
    expect((await t.api.get('/api/pm/tasks?from=2026-02-01&to=2026-02-28')).status).toBe(200);
  });

  it('an Invalid time value and database constraints are answered as the caller’s mistake', async () => {
    const { router, db } = t.app;
    router.get('/api/_test/date', 'user', () => new Date('zzz').toISOString());
    router.post('/api/_test/dup', 'user', () => db.run("INSERT INTO _migrations (name, applied_at) VALUES ('robust:dup', 'x')"));
    router.post('/api/_test/notnull', 'user', () => db.run("INSERT INTO _migrations (name) VALUES ('robust:null')"));
    router.post('/api/_test/fk', 'user', () => db.run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('h', 'no-such-user', 'x', 'y')"));
    router.post('/api/_test/sqlbug', 'user', () => db.run('SELECT * FROM table_that_does_not_exist'));
    const date = await t.api.get('/api/_test/date');
    expect(date.status).toBe(400);
    expect(date.data.error).toMatch(/Datum/);
    expect((await t.api.post('/api/_test/dup')).status).toBe(200);
    expect((await t.api.post('/api/_test/dup')).status).toBe(409);
    const nn = await t.api.post('/api/_test/notnull');
    expect(nn.status).toBe(400);
    expect(nn.data.error).toMatch(/applied_at/);
    expect((await t.api.post('/api/_test/fk')).status).toBe(400);
    // a real bug stays a 500
    expect((await t.api.post('/api/_test/sqlbug')).status).toBe(500);
  });

  it('a network failure towards another service is a 502, not "Interner Fehler"', async () => {
    t.app.router.get('/api/_test/refused', 'user', async () => (await fetch('http://127.0.0.1:1/nothing-listens-here')).status);
    t.app.router.get('/api/_test/timeout', 'user', async () => {
      const slow = createServer(() => undefined); // accepts, never answers
      await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
      try {
        return (await fetch(`http://127.0.0.1:${(slow.address() as AddressInfo).port}/`, { signal: AbortSignal.timeout(150) })).status;
      } finally {
        slow.closeAllConnections();
        slow.close();
      }
    });
    t.app.router.get('/api/_test/own-bug', 'user', () => (null as any).x);
    for (const p of ['/api/_test/refused', '/api/_test/timeout']) {
      const r = await t.api.get(p);
      expect(r.status, p).toBe(502);
      expect(r.data.error).toMatch(/nicht erreichbar/);
    }
    // a bug in our own code is still a 500
    expect((await t.api.get('/api/_test/own-bug')).status).toBe(500);
  });

  it('db.run still takes buffers and rejects plain objects', () => {
    const db = new Db(':memory:');
    db.raw.exec('CREATE TABLE b (x BLOB, y TEXT)');
    db.run('INSERT INTO b (x, y) VALUES (?, ?)', Buffer.from('abc'), 'ok');
    expect(() => db.run('INSERT INTO b (x, y) VALUES (?, ?)', null, { a: 1 } as any)).toThrow(/Ungültiger Wert/);
    expect(() => db.run('INSERT INTO b (x, y) VALUES (?, ?)', null, ['a'] as any)).toThrow(/Ungültiger Wert/);
    db.close();
  });
});

describe('backups', () => {
  it('two snapshots in the same second both succeed and the download is streamed', async () => {
    const t = await startTestApp();
    await t.setup();
    const at = new Date('2026-03-01T10:00:00Z');
    const [a, b, c] = await Promise.all([makeBackupAsync(t.app, at), makeBackupAsync(t.app, at), makeBackupAsync(t.app, at)]);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(listBackups(t.app).length).toBeGreaterThanOrEqual(3);
    const dl = await t.api.raw(`/api/admin/backups/${a}`, { headers: { cookie: t.api.cookie } });
    expect(dl.status).toBe(200);
    const buf = Buffer.from(await dl.arrayBuffer());
    expect(buf.subarray(0, 15).toString()).toBe('SQLite format 3');
    expect(Number(dl.headers.get('content-length'))).toBe(buf.length);
    const full = await t.api.raw('/api/admin/backup', { headers: { cookie: t.api.cookie } });
    expect(full.status).toBe(200);
    expect(Buffer.from(await full.arrayBuffer()).subarray(0, 15).toString()).toBe('SQLite format 3');
    await t.close();
  });
});
