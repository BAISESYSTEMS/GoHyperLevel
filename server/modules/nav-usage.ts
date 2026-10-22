import type { Module } from '../core/app.js';
import { bad } from '../core/http.js';
import { ALWAYS_VISIBLE, MODULE_IDS } from '../services/appearance-model.js';
import { PROMOTE_DAYS } from '../services/areas-model.js';

/**
 * Einfach-Modus: how often each person opens which menu area, so areas under "Mehr" that someone really uses move into
 * their menu at the next session start (web/src/areas/adaptive.ts, server/services/areas-model.ts → promotedFrom).
 * Per person (not per sub-account), one row per area and day, kept for 60 days. It follows the person across devices.
 *
 *   GET  /api/nav/usage    visits per area in the last PROMOTE_DAYS days  → { usage: { contacts: 12, … }, days: 14 }
 *   POST /api/nav/usage    { visits: { route: n, … } } – a batch the browser sends now and then (at most 50 per area)
 */

const KEEP_DAYS = 60;
const AREAS = new Set([...MODULE_IDS, ...ALWAYS_VISIBLE]);
const day = (d = new Date()) => d.toISOString().slice(0, 10);

export const navUsageModule: Module = {
  name: 'nav-usage',
  migrations: [
    [
      '001-init',
      `CREATE TABLE nav_usage (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        route TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, route, day)
      );`,
    ],
  ],
  register(app) {
    const { router, db } = app;

    router.get('/api/nav/usage', 'user', (ctx) => {
      const since = day(new Date(Date.now() - (PROMOTE_DAYS - 1) * 864e5));
      const rows = db.all<{ route: string; n: number }>('SELECT route, SUM(n) AS n FROM nav_usage WHERE user_id = ? AND day >= ? GROUP BY route', ctx.user!.id, since);
      return { usage: Object.fromEntries(rows.map((r) => [r.route, Number(r.n)])), days: PROMOTE_DAYS };
    });

    router.post('/api/nav/usage', 'user', (ctx) => {
      const visits = ctx.body?.visits;
      if (!visits || typeof visits !== 'object' || Array.isArray(visits)) throw bad('visits als Objekt { Bereich: Anzahl }');
      const today = day();
      let saved = 0;
      for (const [route, raw] of Object.entries(visits).slice(0, 80)) {
        const n = Math.min(50, Math.max(0, Math.floor(Number(raw) || 0)));
        // Unknown areas (a plugin page, a typo) are ignored, not an error.
        if (!n || !AREAS.has(route)) continue;
        db.run('INSERT INTO nav_usage (user_id, route, day, n) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, route, day) DO UPDATE SET n = MIN(n + excluded.n, 500)', ctx.user!.id, route, today, n);
        saved++;
      }
      db.run('DELETE FROM nav_usage WHERE user_id = ? AND day < ?', ctx.user!.id, day(new Date(Date.now() - KEEP_DAYS * 864e5)));
      return { ok: true, saved };
    });
  },
};
