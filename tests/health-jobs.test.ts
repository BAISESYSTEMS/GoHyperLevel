import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pinClock, startTestApp, unpinClock } from './helpers.js';
import { todayYmd } from '../server/services/acc-ledger.js';
import { adoptStragglers } from '../server/services/invoice-flow.js';
import { createInvoice } from '../server/modules/payments.js';

/** Background jobs that must keep working when one row is bad, and must not look at the same rows forever. */
describe('invoice adoption does not get stuck on a broken invoice', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  let loc = '';
  let contactId = '';
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
    loc = t.api.location;
    contactId = (await t.api.post('/api/contacts', { email: 'kunde@kunde.example', first_name: 'Max', last_name: 'Kunde' })).data.id;
  });
  afterAll(async () => t.close());

  it('skips the ones that failed and gets to the good one behind them', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const make = (issuedAt: string, items?: string) => {
      const inv = createInvoice(t.app, loc, { contact_id: contactId, items: [{ name: 'Beratung', qty: 1, price_cents: 1000, tax_rate: 19 }] });
      t.app.db.run(`UPDATE invoices SET status = 'sent', issued_at = ?${items ? ', items = ?' : ''} WHERE id = ?`, ...(items ? [issuedAt, items, inv.id] : [issuedAt, inv.id]));
      return inv.id as string;
    };
    // three broken invoices (no price → total is not a number) that come first, then a good one
    const broken = ['2020-01-01T10:00:00Z', '2020-01-02T10:00:00Z', '2020-01-03T10:00:00Z'].map((d) => make(d, '[{"name":"kaputt","qty":1}]'));
    const good = make('2026-01-01T10:00:00Z');

    // the batch is 2 wide: the first run only meets broken invoices
    expect(adoptStragglers(t.app, undefined, 2)).toBe(0);
    expect(errors).toHaveBeenCalledTimes(2);
    // the next run leaves those two alone, fails on the third and reaches the good one
    expect(adoptStragglers(t.app, undefined, 2)).toBe(1);
    expect(errors).toHaveBeenCalledTimes(3);
    expect(t.app.db.get('SELECT finalised_at, number FROM invoices WHERE id = ?', good)).toMatchObject({ finalised_at: expect.any(String) });
    // from now on nothing is tried (and nothing is logged) again
    expect(adoptStragglers(t.app, undefined, 2)).toBe(0);
    expect(errors).toHaveBeenCalledTimes(3);
    for (const id of broken) expect(t.app.db.get('SELECT finalised_at FROM invoices WHERE id = ?', id)?.finalised_at).toBeNull();
    errors.mockRestore();
  });
});

describe('the segment watcher looks at every watched segment, not always the same 40', () => {
  it('45 watched segments are all checked after two runs', async () => {
    const t = await startTestApp();
    await t.setup();
    const def = (tag: string) => ({ type: 'group', op: 'and', items: [{ type: 'tag', tag, has: true }] });
    for (let i = 0; i < 45; i++) {
      const r = await t.api.post('/api/segments', { name: `Segment ${i}`, definition: def(`t${i}`), watch: true });
      expect(r.status, JSON.stringify(r.data)).toBe(200);
    }
    const watchedCount = () => Number(t.app.db.get(`SELECT COUNT(*) AS n FROM mk_segments WHERE watch = 1 AND watched_at IS NOT NULL`)?.n);
    t.app.services.mkWatchSegments();
    expect(watchedCount()).toBe(40);
    t.app.services.mkWatchSegments();
    expect(watchedCount()).toBe(45);
    await t.close();
  });
});

describe('housekeeping jobs use an index', () => {
  it('the hourly deletes and the 15-second ticks no longer read whole tables', async () => {
    const t = await startTestApp();
    // The statements the jobs run (kept in step with the modules by hand; a plan with a bare SCAN of the table is the failure).
    const jobs: [string, string][] = [
      ['email_events', 'DELETE FROM email_events WHERE at < ?'],
      ['tracked_links', 'DELETE FROM tracked_links WHERE created_at < ? AND created_at >= ? AND message_id NOT IN (SELECT id FROM messages)'],
      ['form_events', 'DELETE FROM form_events WHERE at < ?'],
      ['dni_sessions', 'DELETE FROM dni_sessions WHERE last_seen_at < ?'],
      ['voice_turns', 'DELETE FROM voice_turns WHERE at < ?'],
      ['inbox_response_log', 'DELETE FROM inbox_response_log WHERE responded_at < ?'],
      ['community_notifications', 'DELETE FROM community_notifications WHERE read_at IS NOT NULL AND created_at < ?'],
      ['composio_events', 'DELETE FROM composio_events WHERE created_at < ?'],
      ['composio_calls', 'DELETE FROM composio_calls WHERE created_at < ?'],
      ['plugin_events', 'DELETE FROM plugin_events WHERE created_at < ?'],
      ['invoices', `SELECT * FROM invoices WHERE recurring IS NOT NULL AND json_extract(recurring, '$.active') = 1 AND json_extract(recurring, '$.next_at') <= ?`],
      ['tickets', `SELECT * FROM tickets WHERE status_kind IN ('new','open','waiting') AND merged_into IS NULL AND (first_response_at IS NULL AND first_response_warn_at <= ?)`],
      ['tickets', `SELECT id, location_id FROM tickets WHERE csat_due_at <= ? AND csat_sent_at IS NULL AND status_kind IN ('resolved','closed') LIMIT ?`],
    ];
    for (const [table, sql] of jobs) {
      const params = Array(sql.match(/\?/g)?.length ?? 0).fill('x');
      const plan = (t.app.db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((p) => p.detail);
      const bare = plan.filter((d) => new RegExp(`^SCAN (TABLE )?${table}\\b(?!.*USING)`).test(d));
      expect(bare, `${sql}\n${plan.join('\n')}`).toEqual([]);
    }
    await t.close();
  });
});

describe('the bookkeeping default date is the sub-account\'s today', () => {
  it('00:30 on 1 July in Berlin is 1 July (the UTC date is still 30 June), and still 30 June in Los Angeles', async () => {
    const t = await startTestApp();
    await t.setup();
    const berlin = t.api.location;
    const la = (await t.api.post('/api/locations', { name: 'Westfirma', timezone: 'America/Los_Angeles' })).data.id;
    pinClock('2026-06-30T22:30:00Z');
    try {
      expect(new Date().toISOString().slice(0, 10)).toBe('2026-06-30');
      expect(todayYmd(t.app, berlin)).toBe('2026-07-01');
      expect(todayYmd(t.app, la)).toBe('2026-06-30');
      expect(todayYmd()).toBe('2026-06-30');
    } finally {
      unpinClock();
    }
    await t.close();
  });
});
