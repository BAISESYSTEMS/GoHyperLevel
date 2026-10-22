import { afterEach, describe, expect, it, vi } from 'vitest';
import { id } from '../server/core/util.js';
import { cogneeApp, type CogneeApp } from './cognee-helpers.js';

/**
 * A bulk delete emits one `contact.deleted` per contact. With the Wissensgedächtnis on, every one of them used to start a full
 * cleanup pass (all mapped records of the sub-account checked) and a sync cycle of its own – 10 000 passes for 10 000 contacts.
 * They are coalesced now: one pass (and one cycle) for the whole burst. The passes are counted through the engine's exports.
 */
const passes = vi.hoisted(() => ({ reconcile: 0, cycles: 0 }));
vi.mock('../server/services/cognee/sync.js', async (orig) => {
  const m = await orig<typeof import('../server/services/cognee/sync.js')>();
  return {
    ...m,
    reconcileAll: (...a: Parameters<typeof m.reconcileAll>) => (passes.reconcile++, m.reconcileAll(...a)),
    syncCycle: (...a: Parameters<typeof m.syncCycle>) => (passes.cycles++, m.syncCycle(...a)),
  };
});
vi.setConfig({ testTimeout: 120_000 });

let c: CogneeApp;
afterEach(async () => c && (await c.close()));

describe('bulk-deleting contacts with the knowledge memory on', () => {
  it('runs one cleanup pass for 10 000 deleted contacts, not one per contact – and still removes what Cognee holds', async () => {
    c = await cogneeApp();
    await c.connect();
    const at = c.at(c.A);
    const kept = (await at('POST', '/api/contacts', { first_name: 'Bleibt', email: 'bleibt@example.com' })).data;
    const gone = (await at('POST', '/api/contacts', { first_name: 'Geht', email: 'geht@example.com' })).data;
    await at('POST', `/api/contacts/${kept.id}/notes`, { body: 'Notiz bleibt' });
    await at('POST', `/api/contacts/${gone.id}/notes`, { body: 'Notiz geht' });
    await c.share(c.A, { notes: true });
    expect(c.fake.items(`gh_${c.A}_notes`)).toHaveLength(2);

    const db = c.t.app.db;
    const ids: string[] = [];
    const t0 = new Date().toISOString();
    db.tx(() => {
      for (let i = 0; i < 9999; i++) {
        const cid = id();
        ids.push(cid);
        db.run('INSERT INTO contacts (id, location_id, first_name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', cid, c.A, `Massen ${i}`, `m${i}@example.com`, t0, t0);
      }
    });
    ids.push(gone.id);

    await c.idle();
    passes.reconcile = 0;
    passes.cycles = 0;
    const started = Date.now();
    const r = await at('POST', '/api/contacts/bulk', { action: 'delete', ids });
    expect(r.status, r.text).toBe(200);
    expect(r.data.count).toBe(10_000);
    await c.t.app.events.flush();
    await c.idle();
    // one pass for the burst (a pass that happened to start in the middle of it may add one more – never one per contact)
    expect(passes.reconcile).toBeGreaterThanOrEqual(1);
    expect(passes.reconcile).toBeLessThanOrEqual(2);
    expect(passes.cycles).toBeLessThanOrEqual(2);
    expect(Date.now() - started).toBeLessThan(60_000);

    // the deleted contact's note is queued and removed from Cognee, the other one stays
    await c.sync(c.A);
    const left = c.fake.items(`gh_${c.A}_notes`);
    expect(left).toHaveLength(1);
    expect(left[0].text).toContain('Notiz bleibt');
  });

  it('a single delete still cleans up at once', async () => {
    c = await cogneeApp();
    await c.connect();
    const at = c.at(c.A);
    const ct = (await at('POST', '/api/contacts', { first_name: 'Einzeln', email: 'einzeln@example.com' })).data;
    await at('POST', `/api/contacts/${ct.id}/notes`, { body: 'Einzelne Notiz' });
    await c.share(c.A, { notes: true });
    passes.reconcile = 0;
    expect((await at('DELETE', `/api/contacts/${ct.id}`)).status).toBe(200);
    await c.t.app.events.flush();
    await c.idle();
    expect(passes.reconcile).toBe(1);
    expect(c.t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cognee_items WHERE location_id = ?', c.A)!.n).toBe(0);
  });
});
