import { statSync } from 'node:fs';
import type { App, Module } from '../core/app.js';

/**
 * GET /api/admin/metrics – admin only: event-loop lag, slow requests and queries, per-job tick times,
 * SQLite settings and data volume. Shown on Agentur → System; self-hosters use it to decide when the
 * server needs more CPU or a bigger disk cache (docs/performance.md). Nothing here contains request
 * parameters, query values or personal data: routes are patterns, SQL is a normalised fingerprint.
 */

const COUNTED = ['locations', 'contacts', 'opportunities', 'messages', 'tasks', 'invoices', 'workflow_runs'];
const countCache = new WeakMap<App, { at: number; rows: Record<string, number> }>();

/** Row counts, refreshed at most once a minute (COUNT(*) on a big table is not free). */
function rowCounts(app: App) {
  const cached = countCache.get(app);
  if (cached && Date.now() - cached.at < 60_000) return cached.rows;
  const out: Record<string, number> = {};
  for (const t of COUNTED) {
    try {
      out[t] = Number(app.db.get(`SELECT COUNT(*) AS n FROM ${t}`)?.n ?? 0);
    } catch {
      /* table of a module that is not installed */
    }
  }
  countCache.set(app, { at: Date.now(), rows: out });
  return out;
}

function fileMb(path: string): number {
  try {
    return Math.round((statSync(path).size / 1024 / 1024) * 10) / 10;
  } catch {
    return 0;
  }
}

export const systemHealthModule: Module = {
  name: 'system-health',
  register(app) {
    // The query planner's statistics follow the data: refreshed every few hours (bounded sampling, a few ms).
    let optimizedAt = Date.now();
    app.onTick(() => {
      if (Date.now() - optimizedAt < 6 * 3600_000) return;
      optimizedAt = Date.now();
      app.db.optimize();
    });

    app.router.get('/api/admin/metrics', 'admin', () => {
      const file = app.config.dbFile;
      return {
        ...app.perf.snapshot(),
        database: {
          file_mb: file === ':memory:' ? 0 : fileMb(file),
          wal_mb: file === ':memory:' ? 0 : fileMb(`${file}-wal`),
          pragmas: app.db.pragmas(),
          rows: rowCounts(app),
        },
      };
    });
  },
};
