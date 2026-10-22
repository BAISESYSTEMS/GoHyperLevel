import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedPerfData, type SeedResult } from '../scripts/perf-seed';
import { makeBackupAsync } from '../server/modules/backups';
import { locationStats } from '../server/services/location-stats';
import { startTestApp } from './helpers';

/**
 * The speed-ups (grouped counters, indexes, per-location top-N merges, streamed export, background jobs in
 * slices) must give the same answers as the straightforward queries they replaced. The data is the perf
 * seed at 3 % – about 3 000 contacts in two sub-accounts.
 */
describe('big-data queries', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  let seed: SeedResult;
  const db = () => t.app.db;
  const one = (sql: string, ...p: any[]) => Number(Object.values(db().get(sql, ...p) ?? { n: 0 })[0] ?? 0);

  beforeAll(async () => {
    t = await startTestApp();
    seed = await seedPerfData(t.app, 0.03);
    const login = await t.api.post('/api/auth/login', { email: seed.email, password: seed.password });
    expect(login.status).toBe(200);
  });
  afterAll(() => t.close());

  it('seeds the sizes it promises', () => {
    expect(one('SELECT COUNT(*) FROM contacts')).toBe(seed.counts.contacts);
    expect(one('SELECT COUNT(*) FROM opportunities')).toBe(seed.counts.deals);
    expect(one('SELECT COUNT(*) FROM messages')).toBe(seed.counts.messages);
    expect(one('SELECT COUNT(*) FROM tasks')).toBe(seed.counts.tasks);
    expect(one('SELECT COUNT(*) FROM invoices')).toBe(seed.counts.invoices);
    expect(one('SELECT COUNT(*) FROM locations')).toBe(seed.counts.locations);
    expect(seed.counts.contacts).toBeGreaterThan(2000);
  });

  it('locationStats equals the per-sub-account queries it replaced', () => {
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const now = new Date().toISOString();
    const stats = locationStats(t.app, undefined, since);
    expect(stats.size).toBe(seed.counts.locations);
    for (const l of db().all('SELECT id FROM locations')) {
      const s = stats.get(l.id)!;
      expect(s).toEqual({
        contacts: one('SELECT COUNT(*) FROM contacts WHERE location_id = ?', l.id),
        new_contacts: one('SELECT COUNT(*) FROM contacts WHERE location_id = ? AND created_at >= ?', l.id, since),
        open_opportunities: one(`SELECT COUNT(*) FROM opportunities WHERE location_id = ? AND status = 'open'`, l.id),
        open_value: one(`SELECT COALESCE(SUM(value),0) FROM opportunities WHERE location_id = ? AND status = 'open'`, l.id),
        won_value: one(`SELECT COALESCE(SUM(value),0) FROM opportunities WHERE location_id = ? AND status = 'won'`, l.id),
        open_tasks: one('SELECT COUNT(*) FROM tasks WHERE location_id = ? AND done = 0', l.id),
        overdue_tasks: one('SELECT COUNT(*) FROM tasks WHERE location_id = ? AND done = 0 AND due_at IS NOT NULL AND due_at < ?', l.id, now),
        unread: one('SELECT COALESCE(SUM(unread),0) FROM conversations WHERE location_id = ?', l.id),
        drafts: one(`SELECT COUNT(*) FROM messages WHERE location_id = ? AND status = 'draft'`, l.id),
        last_activity: db().get('SELECT MAX(created_at) AS at FROM activities WHERE location_id = ?', l.id)?.at ?? null,
      });
    }
    // One sub-account asked for by id gives the same numbers as the all-accounts pass.
    const first = db().get('SELECT id FROM locations')!.id;
    expect(locationStats(t.app, [first], since).get(first)).toEqual(stats.get(first));
  });

  it('agency overview and project cards show those numbers', async () => {
    const overview = (await t.api.get('/api/agency/overview')).data as any[];
    expect(overview).toHaveLength(seed.counts.locations);
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    for (const l of overview) {
      expect(l.contacts).toBe(one('SELECT COUNT(*) FROM contacts WHERE location_id = ?', l.id));
      expect(l.new_contacts).toBe(one('SELECT COUNT(*) FROM contacts WHERE location_id = ? AND created_at >= ?', l.id, since));
      expect(l.open_value).toBe(one(`SELECT COALESCE(SUM(value),0) FROM opportunities WHERE location_id = ? AND status = 'open'`, l.id));
      expect(l.unread).toBe(one('SELECT COALESCE(SUM(unread),0) FROM conversations WHERE location_id = ?', l.id));
      expect(l.users).toBe(one(`SELECT COUNT(*) FROM users WHERE role = 'member' AND EXISTS (SELECT 1 FROM json_each(users.locations) WHERE value = ?)`, l.id));
      expect(l.last_activity).toBe(db().get('SELECT MAX(created_at) AS at FROM activities WHERE location_id = ?', l.id)?.at ?? null);
      expect(l.funnels).toEqual([]);
    }
    expect(overview.map((l) => l.name)).toEqual([...overview.map((l) => l.name)].sort());

    const projects = (await t.api.get('/api/agency/projects')).data as any[];
    expect(projects).toHaveLength(seed.counts.locations);
    for (const p of projects) {
      expect(p.stats).toEqual({
        contacts: one('SELECT COUNT(*) FROM contacts WHERE location_id = ?', p.id),
        open_opportunities: one(`SELECT COUNT(*) FROM opportunities WHERE location_id = ? AND status = 'open'`, p.id),
        open_value: one(`SELECT COALESCE(SUM(value),0) FROM opportunities WHERE location_id = ? AND status = 'open'`, p.id),
        won_value: one(`SELECT COALESCE(SUM(value),0) FROM opportunities WHERE location_id = ? AND status = 'won'`, p.id),
        open_tasks: one('SELECT COUNT(*) FROM tasks WHERE location_id = ? AND done = 0', p.id),
        overdue_tasks: expect.any(Number),
        unread: one('SELECT COALESCE(SUM(unread),0) FROM conversations WHERE location_id = ?', p.id),
        drafts: one(`SELECT COUNT(*) FROM messages WHERE location_id = ? AND status = 'draft'`, p.id),
        last_activity: db().get('SELECT MAX(created_at) AS at FROM activities WHERE location_id = ?', p.id)?.at ?? null,
      });
      expect(p.profile.uptime).toEqual({ last: null, week_pct: null });
    }
  });

  it('the project uptime counts the whole week, not the last 200 checks', async () => {
    const loc = seed.bigLocation;
    const stamp = (daysAgo: number, i: number) => new Date(Date.now() - daysAgo * 864e5 - i * 1000).toISOString();
    for (let i = 0; i < 300; i++) db().insert('project_checks', { location_id: loc, at: stamp(1, i), ok: i % 4 === 0 ? 0 : 1, status: 200, ms: 50 });
    db().insert('project_checks', { location_id: loc, at: stamp(20, 0), ok: 0, status: 0, ms: 1 });
    const p = (await t.api.get('/api/agency/projects')).data.find((x: any) => x.id === loc);
    expect(p.profile.uptime.last).toMatchObject({ ok: 0, status: 200 });
    expect(p.profile.uptime.week_pct).toBe(75);
  });

  it('uses indexes for the dashboard, agency and mobile queries (no table scans)', () => {
    const loc = seed.bigLocation;
    const plan = (sql: string, ...p: any[]) => db().all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...p).map((r) => r.detail).join(' | ');
    const noScan = (table: string, text: string) => expect(text, text).not.toMatch(new RegExp(`SCAN (${table})( [a-z]+)?(?! USING)(\\s|$|\\|)`));
    const now = new Date().toISOString();
    const cases: [string, string, any[]][] = [
      ['tasks', `SELECT COUNT(*) FROM tasks WHERE location_id = ? AND done = 0 AND due_at < ?`, [loc, now]],
      ['tasks', `SELECT t.id FROM tasks t WHERE t.location_id = ? AND t.done = 0 ORDER BY t.done, COALESCE(t.due_at, '9999'), t.created_at LIMIT 500`, [loc]],
      ['tasks', `SELECT t.id FROM tasks t WHERE t.done = 0 ORDER BY COALESCE(t.due_at, '9999'), t.created_at LIMIT 1000`, []],
      ['activities', `SELECT MAX(created_at) FROM activities WHERE location_id = ?`, [loc]],
      ['opportunities', `SELECT COUNT(*), SUM(value) FROM opportunities WHERE location_id = ? AND status = 'open'`, [loc]],
      ['messages', `SELECT COUNT(*) FROM messages WHERE location_id = ? AND direction = 'out' AND created_at >= ?`, [loc, now]],
      ['messages', `SELECT COUNT(*) FROM messages WHERE location_id = ? AND status = 'draft'`, [loc]],
      ['conversations', `SELECT id FROM conversations WHERE location_id = ? ORDER BY last_message_at DESC LIMIT 10`, [loc]],
      ['conversations', `SELECT SUM(unread) FROM conversations WHERE location_id = ? AND unread > 0`, [loc]],
      ['invoices', `SELECT i.id FROM invoices i WHERE i.location_id = ? AND i.kind = 'invoice' ORDER BY i.created_at DESC LIMIT 1000`, [loc]],
      ['contacts', `SELECT id FROM contacts c ORDER BY COALESCE(c.last_activity_at, c.created_at) DESC LIMIT 300`, []],
      ['contacts', `SELECT id FROM contacts WHERE updated_at > ? ORDER BY updated_at LIMIT 300`, ['2000']],
    ];
    for (const [table, sql, params] of cases) noScan(table, plan(sql, ...params));
    // The expression indexes serve the ORDER BY: no sorter.
    expect(plan(cases[1][1], loc)).not.toContain('TEMP B-TREE');
    expect(plan(cases[2][1])).not.toContain('TEMP B-TREE');
    expect(plan(cases[10][1])).not.toContain('TEMP B-TREE');
    expect(plan(cases[7][1], loc)).not.toContain('TEMP B-TREE');
  });

  it('mobile inbox returns the newest conversations across sub-accounts, like the global sort did', async () => {
    const all = db().all('SELECT id FROM conversations ORDER BY last_message_at DESC LIMIT 12').map((r) => r.id);
    const r = await t.api.get('/api/mobile/inbox?limit=12');
    expect(r.status).toBe(200);
    expect(r.data.map((c: any) => c.conversation_id)).toEqual(all);
    const unread = await t.api.get('/api/mobile/inbox?limit=5&unread=1');
    expect(unread.data.length).toBe(5);
    expect(unread.data.every((c: any) => c.unread > 0)).toBe(true);
    const expected = db().all('SELECT id FROM conversations WHERE unread > 0 ORDER BY last_message_at DESC LIMIT 5').map((r) => r.id);
    expect(unread.data.map((c: any) => c.conversation_id)).toEqual(expected);
  });

  it('mobile deals pick the biggest open deals, projects count tasks and unread', async () => {
    const deals = (await t.api.get('/api/mobile/deals?limit=7')).data;
    const expected = db().all(`SELECT id FROM opportunities WHERE status = 'open' ORDER BY value DESC, updated_at DESC LIMIT 7`).map((r) => r.id);
    expect(deals.top.map((d: any) => d.id)).toEqual(expected);
    const projects = (await t.api.get('/api/mobile/projects')).data as any[];
    expect(projects).toHaveLength(seed.counts.locations);
    for (const p of projects) {
      expect(p.open_tasks).toBe(one('SELECT COUNT(*) FROM tasks WHERE location_id = ? AND done = 0', p.location_id));
      expect(p.unread).toBe(one('SELECT COALESCE(SUM(unread),0) FROM conversations WHERE location_id = ?', p.location_id));
    }
  });

  it('streams the contacts export in pages, gzipped on request, same rows as the list', async () => {
    const loc = seed.bigLocation;
    const total = one('SELECT COUNT(*) FROM contacts WHERE location_id = ?', loc);
    expect(total).toBeGreaterThan(1000); // more than one page of 1000
    const headers = { cookie: t.api.cookie, 'x-location-id': loc, 'x-pghl': '1' };
    const plain = await t.api.raw('/api/contacts/export.csv', { headers: { ...headers, 'accept-encoding': 'identity' } });
    expect(plain.headers.get('content-type')).toContain('text/csv');
    expect(plain.headers.get('content-encoding')).toBeNull();
    const bytes = Buffer.from(await plain.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM for Excel
    const csv = bytes.toString('utf8').slice(1);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(total + 1);
    expect(lines[0]).toContain('first_name,last_name,email');
    // Newest first, like the list; every contact exactly once.
    const newest = db().get('SELECT email FROM contacts WHERE location_id = ? ORDER BY created_at DESC LIMIT 1', loc)!.email;
    expect(lines[1]).toContain(newest);
    expect(new Set(lines.slice(1).map((l) => l.split(',')[2])).size).toBe(total);

    const gz = await t.api.raw('/api/contacts/export.csv', { headers: { ...headers, 'accept-encoding': 'gzip' } });
    // fetch decodes it: the content is the same
    expect((await gz.text()).split('\r\n')).toHaveLength(total + 1);
    const wire = await new Promise<Buffer>((resolve, reject) => {
      import('node:http').then(({ request }) => {
        const r = request(t.base + '/api/contacts/export.csv', { headers: { ...headers, 'accept-encoding': 'gzip' } }, (res) => {
          expect(res.headers['content-encoding']).toBe('gzip');
          expect(res.headers.vary).toContain('Accept-Encoding');
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        r.on('error', reject);
        r.end();
      });
    });
    expect(wire.length).toBeLessThan(csv.length / 2);
    expect(gunzipSync(wire).toString('utf8')).toBe('\uFEFF' + csv);
  });

  it('keeps answering while an export of the big sub-account is streaming', async () => {
    const loc = seed.bigLocation;
    const headers = { cookie: t.api.cookie, 'x-location-id': loc, 'x-pghl': '1', 'accept-encoding': 'identity' };
    const exporting = t.api.raw('/api/contacts/export.csv', { headers }).then((r) => r.text());
    const version = await t.api.raw('/api/version');
    expect(version.status).toBe(200);
    expect((await exporting).length).toBeGreaterThan(1000);
  });

  it('the backup is copied by a worker thread and opens as a complete database', async () => {
    const before = one('SELECT COUNT(*) FROM contacts');
    const name = await makeBackupAsync(t.app, new Date(Date.now() + 5000));
    const file = join(t.app.config.dataDir, 'backups', name);
    const copy = new DatabaseSync(file, { readOnly: true });
    try {
      expect(Number((copy.prepare('SELECT COUNT(*) AS n FROM contacts').get() as any).n)).toBe(before);
      expect((copy.prepare('PRAGMA integrity_check').get() as any).integrity_check).toBe('ok');
    } finally {
      copy.close();
    }
  });
});

describe('health score background job', () => {
  it('scores new contacts by cursor, skips switched-off sub-accounts and fills them in when switched on again', async () => {
    const t = await startTestApp();
    try {
      await t.setup();
      const locA = t.api.location;
      const b = await t.api.post('/api/agency/clients', { name: 'Zweite Firma' });
      const locB = b.data.location?.id ?? b.data.id;
      const mk = async (loc: string, n: number, from = 0) => {
        t.api.setLocation(loc);
        for (let i = from; i < from + n; i++) await t.api.post('/api/contacts', { first_name: `K${i}`, email: `k${i}-${loc}@example.com` });
      };
      await mk(locA, 3);
      await mk(locB, 2);
      const scored = (loc: string) => Number(t.app.db.get('SELECT COUNT(*) AS n FROM health_scores WHERE location_id = ?', loc)!.n);
      // switch B off before the job runs
      t.api.setLocation(locB);
      const s = await t.api.put('/api/helpdesk/settings', { health: { enabled: false } });
      expect(s.status).toBe(200);
      t.app.db.run('DELETE FROM health_scores');
      await t.app.tick();
      expect(scored(locA)).toBe(3);
      expect(scored(locB)).toBe(0);
      // switched on again: the cursor starts over and B is filled in
      await t.api.put('/api/helpdesk/settings', { health: { enabled: true } });
      await t.app.tick();
      expect(scored(locB)).toBe(2);
      // a later contact is picked up from the cursor, nothing is scored twice
      await mk(locA, 1, 10);
      t.app.db.run('DELETE FROM health_scores');
      await t.app.tick();
      expect(scored(locA)).toBe(1); // only the contact after the cursor
    } finally {
      await t.close();
    }
  });
});
