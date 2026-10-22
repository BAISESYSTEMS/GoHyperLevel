import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App, Module } from '../core/app.js';
import { normalizeDomain } from '../core/domains.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { LOCK_LABELS, LOCK_OF, cleanLocks, cleanPrefs, effectivePrefs, type Locks, type Prefs } from '../services/appearance-model.js';
import { checkLogoDataUrl } from '../services/svg-safe.js';
import { cleanTileOrder, mergeTileOrder, trimTileOrder, type TileOrderPatch } from '../services/tile-order.js';

/**
 * Darstellung: what each person chose for themselves (theme, accent, department colours, sidebar, icon
 * pack, density, hidden menu entries) and what the agency set as default or locked for its clients.
 *
 *   GET/PATCH /api/appearance                          own preferences + the effective set (user)
 *   GET       /api/appearance/public                   the defaults for the login page (domain based)
 *   GET/PATCH /api/agency/branding/look                agency defaults and locks (admin)
 *   GET/PATCH /api/agency/locations/:id/branding/look  per-client overrides (admin)
 *   POST      /api/agency/branding/logo                logo / mark / favicon upload: PNG, JPEG, WebP, SVG (admin)
 *
 * Hidden menu entries are a view preference, not a permission: the page stays reachable by its address and
 * the permission areas (modules/permissions) are untouched.
 *
 * `tile_order` (own order of tiles and cards, services/tile-order.ts) is merged grid by grid: `{ tile_order: { "dashboard.stats":
 * [...] } }` changes that grid only, `{ grid: null }` puts it back to the natural order, `tile_order: null` drops all of them.
 * It is per login (not per sub-account, like the theme) and travels once per answer, in `prefs` – never in `effective`.
 */

type PartialPrefs = Partial<Prefs>;
interface Look {
  defaults: PartialPrefs;
  locks: Locks;
}

const SETTINGS_KEY = 'appearance';
const clientKey = (locationId: string) => `appearance:loc:${locationId}`;
/** Offer the first-run setup ("Was willst du tun?") to accounts created within this many days; older ones get a banner once. */
const OFFER_DAYS = 14;
/** Per-person answers and choices that an agency default never carries. */
const PERSONAL = ['asked', 'goal_asked', 'pinned', 'unpinned', 'tile_order'];

/**
 * Checks a body or stored set: cleanPrefs, plus the grids and keys of `tile_order` (cleanTileOrder – kept out of the shared model
 * so the browser's first download does not carry it). Throws an Error with a German message.
 */
function checkPrefs(v: unknown, stored = false) {
  const out = cleanPrefs(v);
  // a stored order that no longer fits the rules keeps every grid that still does (never the person's other choices)
  if (out.tile_order) out.tile_order = (stored ? trimTileOrder(out.tile_order) : cleanTileOrder(out.tile_order)) as Prefs['tile_order'];
  return out;
}

/** A stored set of preferences without the `null` resets; defaults never carry the per-person "asked" flag. */
function storedPrefs(v: unknown, defaultsOnly = false): PartialPrefs {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(checkPrefs(v, true))) if (val !== null && !(defaultsOnly && PERSONAL.includes(k))) out[k] = val;
  return out as PartialPrefs;
}

function readLook(app: App, key: string): Look {
  const row = app.db.get('SELECT value FROM agency_settings WHERE key = ?', key);
  let parsed: any = {};
  try {
    parsed = row ? JSON.parse(row.value) : {};
  } catch {
    /* damaged row: start fresh */
  }
  return { defaults: storedPrefs(parsed.defaults, true), locks: cleanLocks(parsed.locks) };
}

const writeLook = (app: App, key: string, look: Look) =>
  app.db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(look));

/** A client's overrides on top of the agency's (explicit `false` locks of a client open what the agency closed). */
const merge = (agency: Look, client: Look): Look => ({ defaults: { ...agency.defaults, ...client.defaults }, locks: { ...agency.locks, ...client.locks } });

function look(app: App, locationId?: string): Look {
  const agency = readLook(app, SETTINGS_KEY);
  return locationId ? merge(agency, readLook(app, clientKey(locationId))) : agency;
}

function ownPrefs(app: App, userId: string): PartialPrefs {
  const row = app.db.get('SELECT data FROM user_prefs WHERE user_id = ?', userId);
  if (!row) return {};
  try {
    return storedPrefs(JSON.parse(row.data));
  } catch {
    return {};
  }
}
/** The client whose domain the request came in on (crm.kunde.de), same lookup as the branding. */
function locationByHost(app: App, host: string): string | undefined {
  let d = '';
  try {
    d = normalizeDomain(host);
  } catch {
    return undefined;
  }
  return d ? app.db.get(`SELECT id FROM locations WHERE json_extract(settings, '$.branding.app_domain') = ?`, d)?.id : undefined;
}

/** Which client's overrides apply to this request: members → their sub-account, admins → only on a client's own domain. */
function scopeOf(app: App, ctx: Ctx): string | undefined {
  const u = ctx.user!;
  const host = String(ctx.req.headers.host ?? '');
  if (u.role === 'admin') return locationByHost(app, host);
  const want = String(ctx.req.headers['x-location-id'] ?? '');
  return u.locations.includes(want) ? want : u.locations[0];
}

function state(app: App, ctx: Ctx) {
  const u = ctx.user!;
  const admin = u.role === 'admin';
  const { defaults, locks } = look(app, scopeOf(app, ctx));
  const own = ownPrefs(app, u.id);
  const effective = effectivePrefs(defaults, own, locks, admin);
  const created = app.db.get('SELECT created_at FROM users WHERE id = ?', u.id)?.created_at;
  const fresh = created && Date.now() - new Date(created).getTime() < OFFER_DAYS * 864e5;
  // The goal setup is offered once, to new accounts that did not decide yet and may still decide; an agency that preset
  // goals for its clients decided for them.
  const may = (admin || !locks.modules) && !defaults.goals?.length;
  const offer = !effective.asked && !effective.goal_asked && !!fresh && may;
  // Existing logins (older, or who answered the old starter profiles) get a dismissible banner once.
  const banner = !offer && !effective.goal_asked && !effective.goals.length && may;
  // Admins are never locked, so their screen shows nothing as locked (the effective set above already ignores locks).
  // The tile order is personal (never a default, never locked) and can be big: it travels once, in `prefs`.
  const { tile_order: _ownOrder, ...shown } = effective;
  return { prefs: own, effective: shown, defaults, locks: admin ? {} : locks, offer_profiles: offer, offer_goals: banner };
}

/** Applies a body of `{key: value | null}` to a stored set (`tile_order` grid by grid, see above). */
function applyChanges(target: Record<string, unknown>, changes: Record<string, unknown>) {
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete target[k];
    else if (k === 'tile_order') {
      const merged = mergeTileOrder(target.tile_order as Record<string, string[]> | undefined, v as TileOrderPatch);
      if (Object.keys(merged).length) target.tile_order = merged;
      else delete target.tile_order;
    } else target[k] = v;
  }
}

const lockMessage = (keys: string[]) => {
  const groups = [...new Set(keys.map((k) => LOCK_OF[k as keyof Prefs]).filter(Boolean))].map((l) => LOCK_LABELS[l!]);
  return `Von deiner Agentur festgelegt: ${groups.join(', ')}`;
};

export const appearanceModule: Module = {
  name: 'appearance',
  migrations: [
    [
      '001-init',
      `CREATE TABLE user_prefs (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );`,
    ],
  ],
  register(app) {
    const { router, db } = app;
    const uploadDir = join(app.config.dataDir, 'uploads');

    // --- own preferences ---------------------------------------------------------------------------
    router.get('/api/appearance', 'user', (ctx) => state(app, ctx));

    router.patch('/api/appearance', 'user', (ctx) => {
      let changes;
      try {
        changes = checkPrefs(ctx.body);
      } catch (e) {
        throw bad((e as Error).message);
      }
      const keys = Object.keys(changes);
      if (!keys.length) throw bad('Nichts zu speichern');
      const before = state(app, ctx);
      const locks = look(app, scopeOf(app, ctx)).locks;
      if (ctx.user!.role !== 'admin') {
        // A locked group may be sent back unchanged (a whole form saved at once), never changed.
        const refused = keys.filter((k) => {
          const lock = LOCK_OF[k as keyof Prefs];
          if (!lock || !locks[lock]) return false;
          const v = (changes as any)[k];
          return v === null || JSON.stringify(v) !== JSON.stringify((before.effective as any)[k]);
        });
        if (refused.length) throw new HttpError(403, lockMessage(refused));
        for (const k of keys) {
          const lock = LOCK_OF[k as keyof Prefs];
          if (lock && locks[lock]) delete (changes as any)[k];
        }
      }
      const own: Record<string, unknown> = { ...before.prefs };
      applyChanges(own, changes);
      db.run('INSERT INTO user_prefs (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', ctx.user!.id, JSON.stringify(own), now());
      return state(app, ctx);
    });

    router.get('/api/appearance/public', 'public', (ctx) => {
      const { defaults, locks } = look(app, locationByHost(app, String(ctx.req.headers.host ?? '')));
      return { effective: effectivePrefs(defaults, {}, locks, false) };
    });

    // --- agency defaults and locks -----------------------------------------------------------------
    const lookIn = (body: any, current: Look, clientLevel: boolean): Look => {
      const next: Look = { defaults: { ...current.defaults }, locks: { ...current.locks } };
      if (body?.defaults !== undefined) {
        let d;
        try {
          d = cleanPrefs(body.defaults);
        } catch (e) {
          throw bad((e as Error).message);
        }
        for (const k of PERSONAL) delete (d as any)[k];
        applyChanges(next.defaults as Record<string, unknown>, d);
      }
      if (body?.locks !== undefined) {
        const raw = body.locks && typeof body.locks === 'object' ? body.locks : {};
        // A client may inherit a lock (null) – the agency level has no "inherit".
        for (const [k, v] of Object.entries(raw)) {
          if (v === null && clientLevel) delete (next.locks as any)[k];
        }
        Object.assign(next.locks, cleanLocks(raw));
      }
      return next;
    };

    router.get('/api/agency/branding/look', 'admin', () => readLook(app, SETTINGS_KEY));
    router.patch('/api/agency/branding/look', 'admin', (ctx) => {
      const next = lookIn(ctx.body, readLook(app, SETTINGS_KEY), false);
      writeLook(app, SETTINGS_KEY, next);
      return next;
    });
    router.get('/api/agency/locations/:id/branding/look', 'admin', (ctx) => {
      if (!app.location(ctx.params.id)) throw notFound();
      return { ...readLook(app, clientKey(ctx.params.id)), agency: readLook(app, SETTINGS_KEY) };
    });
    router.patch('/api/agency/locations/:id/branding/look', 'admin', (ctx) => {
      if (!app.location(ctx.params.id)) throw notFound();
      const key = clientKey(ctx.params.id);
      const next = lookIn(ctx.body, readLook(app, key), true);
      writeLook(app, key, next);
      return { ...next, agency: readLook(app, SETTINGS_KEY) };
    });

    // --- logo / mark / favicon upload --------------------------------------------------------------
    router.post('/api/agency/branding/logo', 'admin', (ctx) => {
      const name = str(ctx.body?.name, 'Dateiname', { required: true, max: 200 });
      const check = checkLogoDataUrl(ctx.body?.data);
      if (!check.ok) throw bad(check.error);
      mkdirSync(uploadDir, { recursive: true });
      // The stored name's extension comes from the checked type, never from the client's file name.
      const file = `${id(20)}${check.ext}`;
      writeFileSync(join(uploadDir, file), check.buf);
      const row = { id: id(), location_id: String(ctx.req.headers['x-location-id'] ?? '') || 'agency', name, file, mime: check.mime, size: check.buf.length, created_at: now() };
      db.insert('uploads', row);
      return { ...row, url: `${app.baseUrl()}/uploads/${file}` };
    });
  },
};

