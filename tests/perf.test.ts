import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../server/core/db';
import { PerfMonitor, inSlices, sliceTimer, sqlFingerprint } from '../server/core/perf';
import { startTestApp } from './helpers';

describe('SQLite tuning', () => {
  it('sets WAL, synchronous=NORMAL, in-memory temp tables, a 32 MB cache and mmap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pghl-pragma-'));
    const db = new Db(join(dir, 'x.db'));
    try {
      const p = db.pragmas();
      expect(p.journal_mode).toBe('wal');
      expect(p.synchronous).toBe(1); // NORMAL
      expect(p.temp_store).toBe(2); // MEMORY
      expect(p.cache_size).toBe(-32000); // KiB
      expect(p.mmap_size).toBe(256 * 1024 * 1024);
      expect(p.foreign_keys).toBe(1);
      expect(p.busy_timeout).toBe(5000);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes cache and mmap sizes from the environment (mmap 0 = off)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pghl-pragma-'));
    const old = { c: process.env.PGHL_SQLITE_CACHE_MB, m: process.env.PGHL_SQLITE_MMAP_MB };
    process.env.PGHL_SQLITE_CACHE_MB = '64';
    process.env.PGHL_SQLITE_MMAP_MB = '0';
    const db = new Db(join(dir, 'x.db'));
    try {
      expect(db.pragmas().cache_size).toBe(-64000);
      expect(db.pragmas().mmap_size).toBe(0);
    } finally {
      db.close();
      for (const [k, v] of [['PGHL_SQLITE_CACHE_MB', old.c], ['PGHL_SQLITE_MMAP_MB', old.m]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps one prepared statement per SQL text and still sees schema changes', () => {
    const db = new Db(':memory:');
    db.raw.exec('CREATE TABLE t (a INTEGER)');
    db.run('INSERT INTO t (a) VALUES (?)', 1);
    expect(db.prepare('SELECT a FROM t')).toBe(db.prepare('SELECT a FROM t'));
    expect(db.all('SELECT * FROM t')).toEqual([{ a: 1 }]);
    db.raw.exec('ALTER TABLE t ADD COLUMN b TEXT DEFAULT \'x\'');
    db.invalidate(); // migrate() does this itself
    expect(db.all('SELECT * FROM t')).toEqual([{ a: 1, b: 'x' }]);
    db.migrate('add-c', 'ALTER TABLE t ADD COLUMN c INTEGER DEFAULT 7');
    expect(db.all('SELECT * FROM t')).toEqual([{ a: 1, b: 'x', c: 7 }]);
    db.close();
  });
});

describe('result cache (db.memo)', () => {
  it('serves the same value until something is written, and recomputes after a write or the ttl', async () => {
    const db = new Db(':memory:');
    db.raw.exec('CREATE TABLE t (a INTEGER)');
    let runs = 0;
    const read = (ttl = 60_000) => db.memo('count', ttl, () => (runs++, db.get<{ n: number }>('SELECT COUNT(*) n FROM t')!.n));
    expect(read()).toBe(0);
    expect(read()).toBe(0);
    expect(runs).toBe(1);
    db.run('INSERT INTO t (a) VALUES (1)');
    expect(read()).toBe(1);
    expect(runs).toBe(2);
    // A write inside the computation never leaves a result that claims to be current.
    expect(db.memo('w', 60_000, () => (db.run('INSERT INTO t (a) VALUES (2)'), 'x'))).toBe('x');
    let again = 0;
    db.memo('w', 60_000, () => again++);
    expect(again).toBe(1);
    // ttl 0 = always fresh
    read(0);
    read(0);
    expect(runs).toBe(4);
    db.close();
  });

  it('is invisible for users: the dashboard changes right after a write', async () => {
    const t = await startTestApp();
    try {
      await t.setup();
      const before = await t.api.get('/api/dashboard');
      const again = await t.api.get('/api/dashboard');
      expect(again.data).toEqual(before.data);
      await t.api.post('/api/contacts', { first_name: 'Neu', email: 'neu@example.com' });
      const after = await t.api.get('/api/dashboard');
      expect(after.data.contacts.total).toBe(before.data.contacts.total + 1);
      expect(after.data.contacts.new).toBe(before.data.contacts.new + 1);
    } finally {
      await t.close();
    }
  });
});

describe('slow logs never contain values', () => {
  it('turns SQL into a fingerprint without literals or parameters', () => {
    expect(sqlFingerprint(`SELECT * FROM contacts WHERE email = 'max.mustermann@example.com' AND id = 42 -- hello`)).toBe('SELECT * FROM contacts WHERE email = ? AND id = ?');
    expect(sqlFingerprint(`SELECT a WHERE x IN (1, 2, 3, 4) AND y = 'it''s'`)).toBe('SELECT a WHERE x IN (?, …) AND y = ?');
    expect(sqlFingerprint('SELECT a\n   FROM   t')).toBe('SELECT a FROM t');
  });

  it('records slow queries (opt-in) and slow requests by route pattern', async () => {
    const t = await startTestApp();
    try {
      await t.setup();
      t.app.perf.slowQueryMs = 0.0001;
      t.app.db.slowMs = 0.0001;
      t.app.db.onSlow = (sql, ms) => t.app.perf.query(sql, ms);
      t.app.perf.slowRequestMs = 0.0001;
      const c = await t.api.post('/api/contacts', { first_name: 'Geheim', email: 'geheim@example.com' });
      await t.api.get(`/api/contacts/${c.data.id}`);
      const snap = t.app.perf.snapshot();
      expect(snap.queries.enabled).toBe(true);
      expect(snap.queries.slow.length).toBeGreaterThan(0);
      const json = JSON.stringify(snap);
      expect(json).not.toContain('geheim@example.com');
      expect(json).not.toContain(c.data.id);
      expect(snap.requests.slow.some((r) => r.route === '/api/contacts/:id' && r.method === 'GET')).toBe(true);
      expect(snap.requests.top_routes.every((r) => !r.route.includes(c.data.id))).toBe(true);
    } finally {
      await t.close();
    }
  });
});

describe('GET /api/admin/metrics', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
  });
  afterAll(() => t.close());

  it('is for admins only', async () => {
    const anon = await t.api.raw('/api/admin/metrics');
    expect(anon.status).toBe(401);
    const key = await t.api.post('/api/api-keys', { name: 'k' });
    const viaKey = await t.api.raw('/api/admin/metrics', { headers: { authorization: `Bearer ${key.data.key}` } });
    expect(viaKey.status).toBe(403);
  });

  it('reports event-loop lag, memory, jobs, SQLite settings and row counts', async () => {
    await t.app.tick();
    const r = await t.api.get('/api/admin/metrics');
    expect(r.status).toBe(200);
    expect(r.data.event_loop.monitoring).toBe(true);
    expect(r.data.event_loop.current).toEqual(expect.objectContaining({ p50_ms: expect.any(Number), p99_ms: expect.any(Number), max_ms: expect.any(Number) }));
    expect(r.data.memory_mb.rss).toBeGreaterThan(0);
    expect(r.data.requests.total).toBeGreaterThan(0);
    expect(r.data.jobs.length).toBeGreaterThan(0);
    expect(r.data.database.pragmas).toMatchObject({ journal_mode: 'wal', synchronous: 1, temp_store: 2 });
    expect(r.data.database.rows).toMatchObject({ locations: 1, contacts: 0 });
  });
});

describe('time-boxed jobs', () => {
  it('sliceTimer and inSlices give the event loop a turn between slices', async () => {
    const order: string[] = [];
    const pause = sliceTimer(5);
    const burn = (ms: number) => {
      const t = performance.now();
      while (performance.now() - t < ms);
    };
    const other = new Promise<void>((resolve) => setImmediate(() => (order.push('other'), resolve())));
    burn(8);
    await pause(); // over budget: yields, so the setImmediate above runs first
    order.push('after');
    await other;
    expect(order).toEqual(['other', 'after']);

    const seen: number[] = [];
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    await inSlices([1, 2, 3, 4, 5, 6], (n) => (burn(6), void seen.push(n)), 10);
    clearInterval(timer);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ticks).toBeGreaterThan(0);
  });

  it('PerfMonitor counts per route and keeps a bounded ring of slow requests', () => {
    const m = new PerfMonitor();
    m.quiet = true;
    m.slowRequestMs = 10;
    for (let i = 0; i < 300; i++) m.request('GET', '/api/x', 200, 50);
    m.request('GET', '/api/y', 200, 1);
    const s = m.snapshot();
    expect(s.requests.total).toBe(301);
    expect(s.requests.slow.length).toBe(50);
    expect(m.slowRequests.length).toBeLessThanOrEqual(100);
    expect(s.requests.top_routes[0]).toMatchObject({ route: 'GET /api/x', count: 300, slow: 300 });
  });
});
