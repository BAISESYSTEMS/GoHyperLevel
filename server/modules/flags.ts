import type { Module } from '../core/app.js';
import { bad, notFound, str } from '../core/http.js';
import { now } from '../core/util.js';
import { licenseInfo, requirePro } from '../services/werkstatt/license.js';
import { FLAG_NAME_RE, FLAG_STAGES, PRO_STAGES, decide, type FlagContext, type FlagRow, type FlagStage } from '../services/flags.js';

/**
 * Feature flags for core features: `app.services.flags.enabled(name, { locationId, userId })` decides by the
 * rollout stage (Aus → Privat → Sub-Account → Prozent → Alle). A core feature calls `flags.define(name, …)` once
 * so the flag shows up in the admin list (Werkstatt → Funktionen) – new flags start switched off. Unknown names
 * count as off. Admin routes: /api/flags; every login can ask which flags are on for it (/api/flags/me).
 */

const row = (r: any): FlagRow => ({ ...r, users: JSON.parse(r.users || '[]'), locations: JSON.parse(r.locations || '[]') });

export const flagsModule: Module = {
  name: 'flags',
  migrations: [
    [
      '001-init',
      `CREATE TABLE feature_flags (
        name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', stage TEXT NOT NULL DEFAULT 'off',
        percent INTEGER NOT NULL DEFAULT 0, users TEXT NOT NULL DEFAULT '[]', locations TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );`,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const get = (name: string): FlagRow | undefined => {
      const r = db.get('SELECT * FROM feature_flags WHERE name = ?', name);
      return r ? row(r) : undefined;
    };
    const list = (): FlagRow[] => db.all('SELECT * FROM feature_flags ORDER BY name').map(row);

    app.services.flags = {
      enabled: (name: string, ctx: FlagContext = {}): boolean => {
        const f = get(name);
        return f ? decide(f, ctx) : false;
      },
      /** Registers a flag of a core feature (no-op when it exists). `on: true` starts it at "Alle". */
      define: (name: string, o: { description?: string; on?: boolean } = {}) => {
        if (!FLAG_NAME_RE.test(name) || get(name)) return;
        db.insert('feature_flags', { name, description: String(o.description ?? '').slice(0, 300), stage: o.on ? 'all' : 'off', percent: 0, users: '[]', locations: '[]', created_at: now(), updated_at: now() });
      },
      list,
      get,
    };

    const clean = (b: Record<string, any>, cur?: FlagRow) => {
      const patch: Record<string, any> = { updated_at: now() };
      if (b.description !== undefined) patch.description = str(b.description, 'Beschreibung', { max: 300 });
      if (b.stage !== undefined) {
        if (!FLAG_STAGES.some(([k]) => k === b.stage)) throw bad('Stufe: off, private, location, percent oder all.');
        // Rolling out to a share of the sub-accounts is the advanced rollout (Pro); privat, Sub-Account and alle are free.
        if (PRO_STAGES.includes(b.stage) && b.stage !== cur?.stage) requirePro(app, 'rollout');
        patch.stage = b.stage as FlagStage;
      }
      if (b.percent !== undefined) {
        const n = Math.round(Number(b.percent));
        if (!Number.isFinite(n) || n < 0 || n > 100) throw bad('Prozent: 0 bis 100.');
        patch.percent = n;
      }
      const ids = (v: unknown, what: string) => {
        if (!Array.isArray(v)) throw bad(`${what} als Liste angeben.`);
        return [...new Set(v.map((x) => String(x).trim()).filter(Boolean))].slice(0, 500);
      };
      if (b.users !== undefined) patch.users = JSON.stringify(ids(b.users, 'Nutzer').filter((u) => db.get('SELECT 1 FROM users WHERE id = ?', u)));
      if (b.locations !== undefined) patch.locations = JSON.stringify(ids(b.locations, 'Sub-Accounts').filter((l) => app.location(l)));
      return patch;
    };

    router.get('/api/flags', 'admin', (ctx) => ({
      stages: FLAG_STAGES,
      pro_stages: PRO_STAGES,
      license: licenseInfo(app),
      flags: list().map((f) => ({ ...f, on_for_me: decide(f, { userId: ctx.user?.id, locationId: ctx.locationId || undefined }), locations_named: f.locations.map((id) => ({ id, name: app.location(id)?.name ?? id })) })),
      users: db.all(`SELECT id, name, email FROM users ORDER BY name LIMIT 500`),
      sub_accounts: db.all('SELECT id, name FROM locations ORDER BY name LIMIT 500'),
    }));
    router.post('/api/flags', 'admin', (ctx) => {
      const name = String(ctx.body?.name ?? '').trim().toLowerCase();
      if (!FLAG_NAME_RE.test(name)) throw bad('Name: a-z, 0-9 und . _ -, mit Buchstabe beginnend (2–60 Zeichen).');
      if (get(name)) throw bad('Dieses Flag gibt es schon.');
      db.insert('feature_flags', { name, description: '', stage: 'off', percent: 0, users: '[]', locations: '[]', created_at: now(), updated_at: now() });
      const patch = clean(ctx.body ?? {});
      db.run(`UPDATE feature_flags SET ${Object.keys(patch).map((k) => `${k} = ?`).join(', ')} WHERE name = ?`, ...Object.values(patch), name);
      return get(name);
    });
    router.put('/api/flags/:name', 'admin', (ctx) => {
      const cur = get(ctx.params.name);
      if (!cur) throw notFound('Flag nicht gefunden');
      const patch = clean(ctx.body ?? {}, cur);
      db.run(`UPDATE feature_flags SET ${Object.keys(patch).map((k) => `${k} = ?`).join(', ')} WHERE name = ?`, ...Object.values(patch), cur.name);
      return get(cur.name);
    });
    router.delete('/api/flags/:name', 'admin', (ctx) => {
      if (!db.run('DELETE FROM feature_flags WHERE name = ?', ctx.params.name).changes) throw notFound('Flag nicht gefunden');
      return { ok: true };
    });
    /** Which flags are on for the signed-in user in the current sub-account (for gating UI of a core feature). */
    router.get('/api/flags/me', 'location', (ctx) => Object.fromEntries(list().map((f) => [f.name, decide(f, { userId: ctx.user?.id, locationId: ctx.locationId })])));
  },
};
