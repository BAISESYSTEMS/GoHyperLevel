import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanPrefs, PREF_DEFAULTS } from '../server/services/appearance-model';
import { applyOrder, cleanTileOrder, KEY_RE, MAX_CHARS, MAX_GRIDS, MAX_KEYS, mergeTileOrder, mergeVisible, moveKey, safeKey, sameOrder, tileKey, trimTileOrder } from '../server/services/tile-order';
import { startTestApp } from './helpers';

/** Tiles in your own order (docs/theming.md#kacheln-sortieren): the ordering rules, the stored preference, the browser store. */

describe('tile order: applying a saved order', () => {
  it('keeps the saved order, appends new tiles in their natural order and drops tiles that are gone', () => {
    expect(applyOrder(['c', 'a', 'b'], ['a', 'b', 'c'])).toEqual(['c', 'a', 'b']);
    // "d" and "e" are new: at the end, in their natural order; "x" no longer exists
    expect(applyOrder(['c', 'x', 'a'], ['a', 'b', 'c', 'd', 'e'])).toEqual(['c', 'a', 'b', 'd', 'e']);
    expect(applyOrder(undefined, ['a', 'b'])).toEqual(['a', 'b']);
    expect(applyOrder([], ['a', 'b'])).toEqual(['a', 'b']);
    expect(applyOrder(['b', 'b', 'a'], ['a', 'b'])).toEqual(['b', 'a']);
    expect(applyOrder(['a'], [])).toEqual([]);
  });

  it('moves one entry and clamps the target', () => {
    expect(moveKey(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveKey(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveKey(['a', 'b', 'c'], 1, 99)).toEqual(['a', 'c', 'b']);
    expect(moveKey(['a', 'b', 'c'], 1, -5)).toEqual(['b', 'a', 'c']);
    const src = ['a', 'b'];
    expect(moveKey(src, 9, 0)).toEqual(['a', 'b']);
    expect(src).toEqual(['a', 'b']);
    expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false);
  });

  it('keeps the place of tiles the grid does not show right now (filter, "Mehr anzeigen", Einfach-Modus)', () => {
    // saved a b c d e; only a c e are visible and become e a c → b stays behind a, d behind c
    expect(mergeVisible(['a', 'b', 'c', 'd', 'e'], ['e', 'a', 'c'])).toEqual(['e', 'a', 'b', 'c', 'd']);
    // a hidden tile at the very start stays first
    expect(mergeVisible(['x', 'a', 'b'], ['b', 'a'])).toEqual(['x', 'b', 'a']);
    // a run of hidden tiles stays together
    expect(mergeVisible(['a', 'h1', 'h2', 'b'], ['b', 'a'])).toEqual(['b', 'a', 'h1', 'h2']);
    expect(mergeVisible(undefined, ['b', 'a'])).toEqual(['b', 'a']);
    // never more than MAX_KEYS
    const many = Array.from({ length: MAX_KEYS + 20 }, (_, i) => `k${i}`);
    expect(mergeVisible(many, ['k5', 'k1']).length).toBe(MAX_KEYS);
  });

  it('keeps the tiles on screen when the saved list is full of hidden ones – the hidden ones ranked last go', () => {
    // a list full of keys of deleted records, earlier Fokus answers, other sub-accounts …
    const hidden = Array.from({ length: MAX_KEYS }, (_, i) => `h${i}`);
    const merged = mergeVisible(hidden, ['c', 'a', 'b']);
    expect(merged.length).toBe(MAX_KEYS);
    expect(applyOrder(merged, ['a', 'b', 'c'])).toEqual(['c', 'a', 'b']);
    // the hidden keys ranked last were dropped, the others keep their order (ahead of the visible ones, as saved)
    expect(merged).toEqual([...hidden.slice(0, MAX_KEYS - 3), 'c', 'a', 'b']);
    // the next drag on the same grid is saved as well
    const again = mergeVisible(merged, ['a', 'c', 'b']);
    expect(applyOrder(again, ['a', 'b', 'c'])).toEqual(['a', 'c', 'b']);
    // a grid that shows more than MAX_KEYS tiles itself keeps the first ones
    const huge = Array.from({ length: MAX_KEYS + 5 }, (_, i) => `v${i}`);
    expect(mergeVisible(hidden, huge)).toEqual(huge.slice(0, MAX_KEYS));
  });

  it('turns React keys into tile keys', () => {
    expect(tileKey('.$won')).toBe('won');
    expect(tileKey('.0')).toBe('#0');
    expect(tileKey('.2:$abc')).toBe('abc');
    expect(tileKey('.1:0')).toBe('#1/#0');
    // React escapes ":" and "=" in keys
    expect(tileKey('.$plugin=2widget')).toBe('plugin:widget');
    expect(tileKey('.$a=0b')).toBe('a=b');
    expect(tileKey(null)).toBe('');
  });

  it('makes every key storable: kept when it fits, a stable short hash otherwise', () => {
    for (const k of ['won', '#3', 'plugin:widget', 'Bäckerei Korn', 'x_1-2.3', 'a/b']) expect(safeKey(k)).toBe(k);
    const odd = 'kpi~{"preset":"paid_revenue"}';
    expect(KEY_RE.test(odd)).toBe(false);
    expect(safeKey(odd)).toMatch(/^h[0-9a-z]+$/);
    expect(safeKey(odd)).toBe(safeKey(odd));
    expect(safeKey(odd)).not.toBe(safeKey(`${odd} `));
    expect(KEY_RE.test(safeKey('x'.repeat(500)))).toBe(true);
  });
});

describe('tile order: the stored preference', () => {
  it('validates grids, keys and limits', () => {
    expect(cleanTileOrder({ 'dashboard.stats': ['won', 'contacts', 'won'], 'agency.projects': null })).toEqual({ 'dashboard.stats': ['won', 'contacts'], 'agency.projects': null });
    const bad: unknown[] = [
      null,
      [],
      'dashboard',
      { 'bad grid!': ['a'] },
      { '': ['a'] },
      { 'dashboard.stats': 'won' },
      { 'dashboard.stats': [1, 2] },
      { 'dashboard.stats': ['<script>'] },
      { 'dashboard.stats': [''] },
      { 'dashboard.stats': ['x'.repeat(121)] },
      { 'dashboard.stats': Array.from({ length: MAX_KEYS + 1 }, (_, i) => `k${i}`) },
      Object.fromEntries(Array.from({ length: MAX_GRIDS + 1 }, (_, i) => [`g${i}`, ['a']])),
    ];
    for (const v of bad) expect(() => cleanTileOrder(v), JSON.stringify(v)?.slice(0, 80)).toThrow();
    // the shared model only checks the shape (the browser's look cache); grids and keys are the server's job (cleanTileOrder)
    for (const v of [[], 'x', 1, true]) expect(() => cleanPrefs({ tile_order: v }), JSON.stringify(v)).toThrow();
    expect(cleanPrefs({ tile_order: { 'dashboard.stats': ['won'] } })).toEqual({ tile_order: { 'dashboard.stats': ['won'] } });
    expect(cleanPrefs({ tile_order: null })).toEqual({ tile_order: null });
    expect(PREF_DEFAULTS.tile_order).toEqual({});
  });

  it('merges grid by grid, null deletes one, the oldest go beyond the limit', () => {
    const stored = { a: ['1'], b: ['2'] };
    expect(mergeTileOrder(stored, { b: ['3'], c: ['4'] })).toEqual({ a: ['1'], b: ['3'], c: ['4'] });
    expect(mergeTileOrder(stored, { a: null })).toEqual({ b: ['2'] });
    expect(Object.keys(mergeTileOrder(stored, { a: ['9'] }))).toEqual(['b', 'a']);
    const full = Object.fromEntries(Array.from({ length: MAX_GRIDS }, (_, i) => [`g${i}`, ['x']]));
    const next = mergeTileOrder(full, { fresh: ['y'] });
    expect(Object.keys(next).length).toBe(MAX_GRIDS);
    expect(next.g0).toBeUndefined();
    expect(next.fresh).toEqual(['y']);
  });

  it('has room for every grid of the app, and caps the total size', () => {
    // every grid id the web app uses fits, with room to grow (an arranged 61st grid once pushed the dashboard's out)
    const ids = new Set<string>();
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const path = join(dir, f);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(f)) for (const m of readFileSync(path, 'utf8').matchAll(/(?:SortableGrid\b[^>]*?\bid="([^"]+)"|useSortable\(\{ id: '([^']+)')/g)) ids.add(m[1] ?? m[2]);
      }
    };
    walk(join(__dirname, '../web/src'));
    expect(ids.size).toBeGreaterThan(50);
    expect(MAX_GRIDS).toBeGreaterThanOrEqual(ids.size + 50);
    // beyond MAX_CHARS the grids changed longest ago go, the newest stays
    const long = (n: number) => Array.from({ length: MAX_KEYS }, (_, i) => `${n}-${'k'.repeat(100)}-${i}`);
    let all: Record<string, string[]> = {};
    for (let n = 0; n < 12; n++) all = mergeTileOrder(all, { [`g${n}`]: long(n) });
    expect(JSON.stringify(all).length).toBeLessThanOrEqual(MAX_CHARS);
    expect(all.g11).toEqual(long(11));
    expect(all.g0).toBeUndefined();
    // a single body beyond it is refused
    expect(() => cleanTileOrder(Object.fromEntries(Array.from({ length: 12 }, (_, n) => [`g${n}`, long(n)])))).toThrow(/zu groß/);
  });

  it('makes a stored copy fit without throwing it away: grid by grid, key by key', () => {
    const tooMany = Object.fromEntries(Array.from({ length: MAX_GRIDS + 5 }, (_, i) => [`g${i}`, ['x']]));
    const trimmed = trimTileOrder({ ...tooMany, 'bad grid!': ['a'], keys: ['ok', '<b>', 7, 'ok', 'fine'], notalist: 'x' });
    expect(Object.keys(trimmed).length).toBe(MAX_GRIDS);
    // the oldest grids go first, the newest stay
    expect(trimmed.g0).toBeUndefined();
    expect(trimmed.keys).toEqual(['ok', 'fine']);
    expect(trimmed['bad grid!']).toBeUndefined();
    expect(trimmed.notalist).toBeUndefined();
    for (const v of [null, 'x', [], 3]) expect(trimTileOrder(v)).toEqual({});
  });
});

describe('tile order: PATCH /api/appearance', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  const login = async (email: string) => {
    t.api.clearCookie();
    expect((await t.api.post('/api/auth/login', { email, password: 'geheim123' })).status).toBe(200);
  };
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
    expect((await t.api.post('/api/users', { email: 'kundin@example.com', name: 'Kundin', password: 'geheim123', role: 'member', locations: [t.api.location] })).status).toBe(200);
  });
  afterAll(() => t.close());

  it('stores the order per person and grid, merged grid by grid', async () => {
    const r = await t.api.patch('/api/appearance', { tile_order: { 'dashboard.stats': ['won', 'contacts'] } });
    expect(r.status).toBe(200);
    expect(r.data.prefs.tile_order).toEqual({ 'dashboard.stats': ['won', 'contacts'] });
    // it travels once per answer: in prefs, never in effective
    expect(r.data.effective.tile_order).toBeUndefined();
    // another grid: the first one stays
    await t.api.patch('/api/appearance', { tile_order: { 'agency.projects': ['p2', 'p1'] } });
    const both = await t.api.get('/api/appearance');
    expect(both.data.prefs.tile_order).toEqual({ 'dashboard.stats': ['won', 'contacts'], 'agency.projects': ['p2', 'p1'] });
    // another preference leaves the order alone
    await t.api.patch('/api/appearance', { density: 'compact' });
    expect((await t.api.get('/api/appearance')).data.prefs.tile_order).toEqual({ 'dashboard.stats': ['won', 'contacts'], 'agency.projects': ['p2', 'p1'] });
    // null resets one grid, then all
    const one = await t.api.patch('/api/appearance', { tile_order: { 'dashboard.stats': null } });
    expect(one.data.prefs.tile_order).toEqual({ 'agency.projects': ['p2', 'p1'] });
    const all = await t.api.patch('/api/appearance', { tile_order: null });
    expect(all.data.prefs.tile_order).toBeUndefined();
    expect(all.data.effective.tile_order).toBeUndefined();
    // resetting the last grid leaves nothing behind
    await t.api.patch('/api/appearance', { tile_order: { 'x.y': ['a'] } });
    expect((await t.api.patch('/api/appearance', { tile_order: { 'x.y': null } })).data.prefs.tile_order).toBeUndefined();
  });

  it('rejects what does not fit', async () => {
    for (const tile_order of [['a'], 'x', { 'bad grid!': ['a'] }, { 'dashboard.stats': 'won' }, { 'dashboard.stats': [{ k: 1 }] }, { 'dashboard.stats': ['<b>'] }, { g: Array.from({ length: MAX_KEYS + 1 }, (_, i) => `k${i}`) }])
      expect((await t.api.patch('/api/appearance', { tile_order })).status, JSON.stringify(tile_order).slice(0, 60)).toBe(400);
  });

  it('is personal: other people do not see it, locks do not apply, agency defaults never carry it', async () => {
    await t.api.patch('/api/appearance', { tile_order: { 'dashboard.stats': ['reviews'] } });
    // the agency locks everything it can and tries to preset an order
    expect((await t.api.patch('/api/agency/branding/look', { defaults: { tile_order: { 'dashboard.stats': ['won'] } }, locks: { theme: true, modules: true, density: true } })).status).toBe(200);
    expect((await t.api.get('/api/agency/branding/look')).data.defaults.tile_order).toBeUndefined();
    await login('kundin@example.com');
    const mine = await t.api.get('/api/appearance');
    expect(mine.data.prefs.tile_order).toBeUndefined();
    const set = await t.api.patch('/api/appearance', { tile_order: { 'dashboard.stats': ['won', 'pipeline'] } });
    expect(set.status).toBe(200);
    expect(set.data.prefs.tile_order).toEqual({ 'dashboard.stats': ['won', 'pipeline'] });
    await login('chef@example.com');
    expect((await t.api.get('/api/appearance')).data.prefs.tile_order).toEqual({ 'dashboard.stats': ['reviews'] });
  });

  it('keeps what still fits of a stored order written under other rules', async () => {
    const me = (await t.api.get('/api/me')).data.user.id;
    const old = { ...Object.fromEntries(Array.from({ length: MAX_GRIDS + 3 }, (_, i) => [`g${i}`, ['a']])), 'dashboard.stats': ['won', '<x>', 'contacts'] };
    t.app.db.run('UPDATE user_prefs SET data = ? WHERE user_id = ?', JSON.stringify({ theme: 'wald', tile_order: old }), me);
    const r = await t.api.get('/api/appearance');
    expect(r.data.prefs.theme).toBe('wald');
    expect(Object.keys(r.data.prefs.tile_order).length).toBe(MAX_GRIDS);
    expect(r.data.prefs.tile_order['dashboard.stats']).toEqual(['won', 'contacts']);
    expect(r.data.prefs.tile_order.g0).toBeUndefined();
    // and the next change is stored on top of it
    expect((await t.api.patch('/api/appearance', { tile_order: { 'x.y': ['b', 'a'] } })).data.prefs.tile_order['x.y']).toEqual(['b', 'a']);
  });
});

describe('tile order: the browser store', () => {
  const mem = new Map<string, string>();
  const calls: { method: string; url: string; body: any }[] = [];
  let server: Record<string, string[]> = {};
  let offline = false;
  let status = 200;

  beforeEach(() => {
    mem.clear();
    calls.length = 0;
    server = {};
    offline = false;
    status = 200;
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
    vi.stubGlobal('window', { addEventListener: () => undefined, dispatchEvent: () => true, location: { pathname: '/app' } });
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (offline) throw new TypeError('Failed to fetch');
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: init.method ?? 'GET', url, body });
      if (status !== 200) return { ok: false, status, headers: { get: () => 'application/json' }, json: async () => ({ error: 'nein' }) };
      for (const [g, list] of Object.entries((body?.tile_order ?? {}) as Record<string, string[] | null>)) {
        if (list) server[g] = list;
        else delete server[g];
      }
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ prefs: { tile_order: { ...server } }, effective: {} }) };
    });
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const settle = async () => {
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(0);
  };

  it('saves at once in the browser and a moment later on the server, grid by grid', async () => {
    const s = await import('../web/src/sortable/store');
    s.bindUser('u1');
    s.saveOrder('dashboard.stats', ['won', 'contacts', 'pipeline'], ['contacts', 'pipeline', 'won']);
    expect(s.getOrder('dashboard.stats')).toEqual(['won', 'contacts', 'pipeline']);
    expect(JSON.parse(mem.get('pghl.tile-order:u1')!).o['dashboard.stats']).toEqual(['won', 'contacts', 'pipeline']);
    expect(calls).toEqual([]);
    await settle();
    expect(calls).toEqual([{ method: 'PATCH', url: '/api/appearance', body: { tile_order: { 'dashboard.stats': ['won', 'contacts', 'pipeline'] } } }]);
    expect(JSON.parse(mem.get('pghl.tile-order:u1')!).d).toEqual([]);
    // arranged back to the natural order: the saved order goes
    s.saveOrder('dashboard.stats', ['contacts', 'pipeline', 'won'], ['contacts', 'pipeline', 'won']);
    expect(s.getOrder('dashboard.stats')).toBeUndefined();
    await settle();
    expect(calls[1].body).toEqual({ tile_order: { 'dashboard.stats': null } });
    s.saveOrder('a', ['2', '1'], ['1', '2']);
    s.resetOrder('a');
    expect(s.getOrder('a')).toBeUndefined();
  });

  it('keeps the place of hidden tiles when a filtered grid is arranged', async () => {
    const s = await import('../web/src/sortable/store');
    s.bindUser('u1');
    s.saveOrder('agency.projects', ['a', 'b', 'c', 'd'], ['d', 'c', 'b', 'a']);
    // only a and c are shown (status filter), c is dragged before a: the hidden ones stay behind their neighbour (b behind a, d behind c)
    s.saveOrder('agency.projects', ['c', 'a'], ['a', 'c']);
    expect(s.getOrder('agency.projects')).toEqual(['c', 'd', 'a', 'b']);
  });

  it('offline: stays in the browser and is sent once the server answers again; a server copy never overwrites it meanwhile', async () => {
    let s = await import('../web/src/sortable/store');
    s.bindUser('u1');
    offline = true;
    s.saveOrder('dashboard.cards', ['next', 'leads'], ['leads', 'next']);
    await settle();
    expect(JSON.parse(mem.get('pghl.tile-order:u1')!).d).toEqual(['dashboard.cards']);
    // the server's (older) copy arrives: the unsent grid stays, the others follow the server
    s.adoptServer({ 'dashboard.cards': ['leads', 'next'], 'dashboard.stats': ['won'] });
    expect(s.getOrder('dashboard.cards')).toEqual(['next', 'leads']);
    expect(s.getOrder('dashboard.stats')).toEqual(['won']);
    // next page load, back online: the browser's copy shows at once and goes to the server
    offline = false;
    vi.resetModules();
    s = await import('../web/src/sortable/store');
    s.bindUser('u1');
    expect(s.getOrder('dashboard.cards')).toEqual(['next', 'leads']);
    await settle();
    expect(calls.at(-1)?.body).toEqual({ tile_order: { 'dashboard.cards': ['next', 'leads'] } });
    expect(server['dashboard.cards']).toEqual(['next', 'leads']);
    expect(JSON.parse(mem.get('pghl.tile-order:u1')!).d).toEqual([]);
  });

  it('a grid mounting after a save keeps the saved order (the look store still holds the copy from sign-in)', async () => {
    const s = await import('../web/src/sortable/store');
    s.bindUser('u1');
    // look.prefs.tile_order from GET /api/appearance at sign-in – the sortable store saves through its own PATCH, which the
    // look store never sees
    const atSignIn = { 'dashboard.cards': ['leads', 'next'] };
    s.adoptLook(atSignIn);
    expect(s.getOrder('dashboard.cards')).toEqual(['leads', 'next']);
    s.saveOrder('agency.projects', ['p2', 'p1'], ['p1', 'p2']);
    s.saveOrder('dashboard.cards', ['next', 'leads'], ['leads', 'next']);
    await settle();
    expect(server['agency.projects']).toEqual(['p2', 'p1']);
    // another page, the next Fokus answer, a later tab: its grid mounts and hands over the same (old) copy again
    s.adoptLook(atSignIn);
    expect(s.getOrder('agency.projects')).toEqual(['p2', 'p1']);
    expect(s.getOrder('dashboard.cards')).toEqual(['next', 'leads']);
    expect(JSON.parse(mem.get('pghl.tile-order:u1')!).o).toEqual({ 'agency.projects': ['p2', 'p1'], 'dashboard.cards': ['next', 'leads'] });
    // the same with a sign-in that brought no saved orders at all (look.prefs.tile_order = {})
    const empty = {};
    s.adoptLook(empty);
    s.adoptLook(empty);
    expect(s.getOrder('agency.projects')).toBeUndefined();
    s.saveOrder('agency.projects', ['p2', 'p1'], ['p1', 'p2']);
    await settle();
    s.adoptLook(empty);
    expect(s.getOrder('agency.projects')).toEqual(['p2', 'p1']);
    // a new answer of the look store (another preference changed, on another device too) is the server's newest copy
    s.adoptLook({ 'agency.projects': ['p1', 'p2'] });
    expect(s.getOrder('agency.projects')).toEqual(['p1', 'p2']);
    expect(s.getOrder('dashboard.cards')).toBeUndefined();
  });

  it('never writes more than the server accepts, and a copy beyond the rules keeps what fits', async () => {
    let s = await import('../web/src/sortable/store');
    s.bindUser('u1');
    // a copy from an older version: more grids than allowed, one damaged grid, an unsent change
    const o: Record<string, unknown> = Object.fromEntries(Array.from({ length: MAX_GRIDS + 1 }, (_, i) => [`g${i}`, ['b', 'a']]));
    o['bad grid!'] = ['x'];
    mem.set('pghl.tile-order:u2', JSON.stringify({ v: 1, o: { ...o, fresh: ['y', 'x'] }, d: ['fresh', 'bad grid!'] }));
    offline = true;
    s.bindUser('u2');
    expect(s.getOrder('fresh')).toEqual(['y', 'x']);
    expect(s.getOrder(`g${MAX_GRIDS}`)).toEqual(['b', 'a']);
    expect(s.getOrder('g0')).toBeUndefined();
    // offline, one more grid: the browser's copy stays within the limit, so the next page load reads all of it
    s.saveOrder('newest', ['2', '1'], ['1', '2']);
    await settle();
    const stored = JSON.parse(mem.get('pghl.tile-order:u2')!);
    expect(Object.keys(stored.o).length).toBe(MAX_GRIDS);
    expect(stored.d).toEqual(expect.arrayContaining(['fresh', 'newest']));
    vi.resetModules();
    s = await import('../web/src/sortable/store');
    s.bindUser('u2');
    expect(s.getOrder('newest')).toEqual(['2', '1']);
    expect(s.getOrder('fresh')).toEqual(['y', 'x']);
    offline = false;
    await settle();
    expect(server.newest).toEqual(['2', '1']);
    expect(server.fresh).toEqual(['y', 'x']);
    // an unsent grid id the server would refuse (400 for the whole body) is not sent at all
    expect(Object.keys(calls.at(-1)!.body.tile_order)).not.toContain('bad grid!');
  });

  it('keeps each login apart and gives up on a change the server refuses', async () => {
    const s = await import('../web/src/sortable/store');
    s.bindUser('u1');
    s.saveOrder('g', ['b', 'a'], ['a', 'b']);
    s.bindUser('u2');
    expect(s.getOrder('g')).toBeUndefined();
    status = 403;
    s.saveOrder('g', ['y', 'x'], ['x', 'y']);
    await settle();
    // refused (demo, read-only): kept in this browser, not retried forever
    expect(s.getOrder('g')).toEqual(['y', 'x']);
    expect(JSON.parse(mem.get('pghl.tile-order:u2')!).d).toEqual([]);
    s.bindUser('u1');
    expect(s.getOrder('g')).toEqual(['b', 'a']);
  });
});
