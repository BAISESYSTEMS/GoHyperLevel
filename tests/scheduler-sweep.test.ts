import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pinClock, startTestApp, unpinClock } from './helpers.js';
import { seedDemo } from '../server/services/demo-seed.js';
import { adoptStragglers } from '../server/services/invoice-flow.js';
import { installOutboundGuard, uninstallOutboundGuard } from '../server/services/outbound-guard.js';

/**
 * Second bug sweep, background jobs: every registered job runs on an empty database and on the demo data – no job throws, a second run
 * changes nothing (no reminder, row or log line twice), also a day later; and the 30-second invoice job reads its index, not the table.
 */

type T = Awaited<ReturnType<typeof startTestApp>>;
const logs: string[] = [];
beforeAll(() => {
  installOutboundGuard();
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : String(x))).join(' ').slice(0, 400)));
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void logs.push(`warn ${a.map(String).join(' ').slice(0, 300)}`));
});
afterAll(() => {
  unpinClock();
  vi.restoreAllMocks();
  uninstallOutboundGuard();
});

const counts = (t: T) =>
  Object.fromEntries(
    t.app.db
      .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%fts%'`)
      .map(({ name }) => [name, Number(t.app.db.get(`SELECT COUNT(*) n FROM "${name}"`)?.n ?? 0)]),
  );
const grown = (a: Record<string, number>, b: Record<string, number>) => Object.keys(b).filter((k) => b[k] > (a[k] ?? 0)).map((k) => `${k}: ${a[k] ?? 0} → ${b[k]}`);

async function sweep(seed: boolean) {
  const t = await startTestApp();
  try {
    await t.setup();
    if (seed) await seedDemo(t.app, {});
    const l0 = logs.length;
    await t.app.tick();
    // batched backfills (health scores: 200 contacts per tick) need a second tick on the demo data
    if (seed) await t.app.tick();
    const first = counts(t);
    await t.app.tick();
    const second = counts(t);
    // a day and an hour later: the daily jobs run again – once
    pinClock(new Date(Date.now() + 25 * 3600_000).toISOString());
    await t.app.tick();
    const third = counts(t);
    await t.app.tick();
    const fourth = counts(t);
    unpinClock();
    const jobs = [...((t.app.perf as any).jobs as Map<string, { maxMs: number }>).entries()];
    return { logs: logs.slice(l0), again: grown(first, second), dayLater: grown(third, fourth), jobs };
  } finally {
    unpinClock();
    await t.close();
  }
}

describe('background jobs', () => {
  for (const seed of [false, true]) {
    it(`run without errors and change nothing on a second run (${seed ? 'demo data' : 'empty database'})`, async () => {
      const r = await sweep(seed);
      expect(r.jobs.length).toBeGreaterThanOrEqual(100);
      expect(r.logs).toEqual([]);
      expect(r.again).toEqual([]);
      expect(r.dayLater).toEqual([]);
      // bounded: no single job near the 60-second budget on this data
      expect(r.jobs.filter(([, j]) => j.maxMs > 5000).map(([name]) => name)).toEqual([]);
    }, 300_000);
  }

  it('a job that throws is named in the log', async () => {
    const t = await startTestApp();
    try {
      t.app.onTick(() => {
        throw new Error('kaputt');
      });
      const l0 = logs.length;
      await t.app.tick();
      expect(logs.slice(l0)).toEqual([expect.stringMatching(/^\[tick\] core: Error: kaputt/)]);
    } finally {
      await t.close();
    }
  });

  it('the invoice adoption (every 30 s) reads the partial index instead of the whole invoice table', async () => {
    const t = await startTestApp();
    try {
      const seen: string[] = [];
      const prepare = t.app.db.prepare.bind(t.app.db);
      (t.app.db as any).prepare = (sql: string) => {
        if (/FROM invoices WHERE finalised_at IS NULL/.test(sql)) seen.push(sql);
        return prepare(sql);
      };
      adoptStragglers(t.app);
      expect(seen).toHaveLength(1);
      const plan = t.app.db.raw.prepare(`EXPLAIN QUERY PLAN ${seen[0]}`).all(50) as { detail: string }[];
      expect(plan.map((p) => p.detail).join(' | ')).toContain('USING INDEX invoices_unadopted');
    } finally {
      await t.close();
    }
  });
});
