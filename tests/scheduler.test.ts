import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestApp } from './helpers.js';

/**
 * The scheduler runs the background jobs one after the other. One job that never comes back (a mail server that does not
 * answer, an API without a timeout) must not stop every job behind it, and no job may be started again while its last
 * run is still going.
 */
describe('scheduler tick', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => {
    t = await startTestApp({ jobBudgetMs: 60 });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await t.close();
  });

  it('goes on with the next job when one hangs, and does not start the hung one twice', async () => {
    let hungStarts = 0;
    let after = 0;
    let hang = true;
    let release: () => void = () => undefined;
    t.app.onTick(
      () =>
        hang
          ? new Promise<void>((resolve) => {
              hungStarts++;
              release = resolve;
            })
          : undefined,
    );
    t.app.onTick(() => void after++);

    const t0 = Date.now();
    await t.app.tick();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(hungStarts).toBe(1);
    expect(after).toBe(1);

    await t.app.tick();
    expect(hungStarts).toBe(1); // still running: not started a second time
    expect(after).toBe(2); // the job behind it runs on every tick

    release();
    await new Promise((r) => setTimeout(r, 10));
    await t.app.tick();
    expect(hungStarts).toBe(2); // finished: runs again
    hang = false;
    release();
  });

  it('a job that throws does not stop the others, and runs again next time', async () => {
    let bad = 0;
    let good = 0;
    t.app.onTick(() => {
      bad++;
      throw new Error('kaputt');
    });
    t.app.onTick(async () => {
      good++;
    });
    await t.app.tick();
    await t.app.tick();
    expect(bad).toBe(2);
    expect(good).toBe(2);
  });

  it('two ticks at once do not run the same job twice', async () => {
    let starts = 0;
    let release: () => void = () => undefined;
    t.app.onTick(
      () =>
        new Promise<void>((resolve) => {
          starts++;
          release = resolve;
          setTimeout(resolve, 20);
        }),
    );
    await Promise.all([t.app.tick(), t.app.tick()]);
    expect(starts).toBe(1);
    release();
  });
});
