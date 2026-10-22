import type { App, Module } from '../core/app.js';
import { readConn } from '../services/cognee/connection.js';
import { reconcileAll, queueContactErasure, syncCycle, type CycleReport } from '../services/cognee/sync.js';
import { refreshPosture } from './cognee.js';

/**
 * The background job of the Wissensgedächtnis: every few seconds the scheduler tick looks which sub-accounts have work
 * (sharing on, data in Cognee, deletions queued) and runs one bounded sync cycle for each – in the background, never inside
 * a request and never holding up the other jobs. It also hooks the GDPR erase: whatever Cognee holds about an erased
 * contact is queued for deletion in the same transaction. Engine: services/cognee/sync.ts.
 */

const IDLE_MS = 60_000;
const POSTURE_EVERY_MS = 24 * 3_600_000;

export const cogneeSyncModule: Module = {
  name: 'cognee-sync',
  register(app: App) {
    const running = new Map<string, Promise<CycleReport>>();
    const nextAt = new Map<string, number>();
    let ticking = false;
    let lastPosture = 0;

    /** One cycle for a sub-account; waits for one that is already running and then runs a fresh one (so the caller sees its own changes). */
    const syncNow = async (loc: string, opts: { full?: boolean; background?: boolean } = {}): Promise<CycleReport> => {
      while (running.has(loc)) await running.get(loc)!.catch(() => undefined);
      const p = syncCycle(app, loc, opts)
        .catch((e): CycleReport => {
          console.error('[cognee]', e);
          return { locationId: loc, types: [], deleted: 0, more: false };
        })
        .finally(() => running.delete(loc));
      running.set(loc, p);
      return p;
    };

    /** Several cycles in a row until nothing is waiting (a graph build in progress counts as waiting). */
    const syncUntilIdle = async (loc: string, opts: { full?: boolean; max?: number } = {}): Promise<CycleReport> => {
      let rep = await syncNow(loc, { full: opts.full });
      for (let i = 1; rep.more && i < (opts.max ?? 25); i++) rep = await syncNow(loc);
      return rep;
    };

    const kick = (loc: string, opts: { full?: boolean } = {}) => {
      nextAt.delete(loc);
      void syncNow(loc, opts);
    };

    /**
     * Deleted contacts, coalesced: a bulk delete emits one `contact.deleted` per contact, and each used to start a full
     * cleanup pass (every mapped record of the sub-account checked) and a sync cycle – 10 000 of each for 10 000 contacts.
     * The events of one burst only mark the sub-account; one pass and one cycle follow once the burst has been delivered.
     */
    const cleanup = new Map<string, { reconcile: boolean }>();
    let cleanupPass: Promise<void> | null = null;
    const cleanupSoon = (loc: string, reconcile: boolean) => {
      cleanup.set(loc, { reconcile: reconcile || !!cleanup.get(loc)?.reconcile });
      // setImmediate from inside a listener runs after every listener the event bus has already queued (the whole burst)
      cleanupPass ??= new Promise<void>((r) => setImmediate(r)).then(() => {
        cleanupPass = null;
        const work = [...cleanup];
        cleanup.clear();
        for (const [l, w] of work) {
          try {
            if (w.reconcile) reconcileAll(app, l);
          } catch (e) {
            console.error('[cognee] cleanup', (e as Error).message);
          }
          kick(l);
        }
      });
    };

    const idle = async () => {
      while (running.size || cleanupPass) {
        if (cleanupPass) await cleanupPass;
        await Promise.all([...running.values()].map((p) => p.catch(() => undefined)));
      }
    };

    app.services.cognee = { syncNow, syncUntilIdle, kick, idle };

    // The public demo sends nothing anywhere (core guard); nothing to sync there.
    const due = (): string[] =>
      app.config.demoMode
        ? []
        : app.db
            .all<{ location_id: string }>(`SELECT location_id FROM cognee_settings WHERE enabled = 1 UNION SELECT location_id FROM cognee_items UNION SELECT location_id FROM cognee_deletions`)
            .map((r) => r.location_id);

    app.onTick(() => {
      if (ticking) return;
      ticking = true;
      void (async () => {
        try {
          for (const loc of due()) {
            if ((nextAt.get(loc) ?? 0) > Date.now()) continue;
            const rep = await syncNow(loc, { background: true });
            nextAt.set(loc, Date.now() + (rep.more ? 0 : IDLE_MS));
          }
          // Once a day: does the server still ask for a login? (the status panels warn when not)
          const conn = readConn(app);
          if (conn && Date.now() - lastPosture > POSTURE_EVERY_MS) {
            lastPosture = Date.now();
            await refreshPosture(app, conn).catch(() => undefined);
          }
        } catch (e) {
          console.error('[cognee]', e);
        } finally {
          ticking = false;
        }
      })();
    });

    // GDPR: runs inside the erase transaction (modules/privacy.ts) – the deletions are queued atomically with it and sent right after.
    app.services.privacyErase = [
      ...(app.services.privacyErase ?? []),
      (a: App, locationId: string, contact: { id: string }) => {
        const n = queueContactErasure(a, locationId, contact.id);
        if (n) a.services.audit?.({ action: 'cognee.erase', locationId, actor: 'Wissensgedächtnis', summary: `${n} ${n === 1 ? 'Eintrag' : 'Einträge'} einer gelöschten Person in Cognee zur Löschung vorgemerkt` });
      },
    ];
    app.events.on('contact.deleted', (e) => {
      // Only where the memory holds something: a contact deleted the normal way takes its notes, messages and tickets
      // with it – those records are noted as gone and their data items queued. A burst (bulk delete) gets one pass: cleanupSoon.
      const marked = cleanup.get(e.locationId);
      if (marked && (marked.reconcile || e.data.erased)) return;
      if (!app.db.get('SELECT 1 FROM cognee_items WHERE location_id = ? UNION ALL SELECT 1 FROM cognee_deletions WHERE location_id = ? LIMIT 1', e.locationId, e.locationId)) return;
      cleanupSoon(e.locationId, !e.data.erased);
    });
  },
};
