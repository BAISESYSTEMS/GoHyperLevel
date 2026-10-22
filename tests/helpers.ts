import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, type Config } from '../server/core/app.js';
import { addDaysYmd, ymdInTz } from '../server/core/time.js';
import { MODULES } from '../server/modules/index.js';

/**
 * Moves `new Date()` / `Date.now()` to an instant that then keeps running at full millisecond resolution (a fixed offset to the
 * real clock; timers are untouched, and message/row timestamps stay distinct), so a test can run at 22:30 UTC = 00:30 the next
 * day in Berlin whatever the real time is. SQLite's own `'now'` keeps the real time. Undo with `unpinClock()`.
 */
const RealDate = Date;
export function pinClock(iso: string) {
  unpinClock();
  const offset = RealDate.parse(iso) - RealDate.now();
  const now = () => RealDate.now() + offset;
  const Pinned = function (this: unknown, ...args: unknown[]) {
    if (!new.target) return new RealDate(now()).toString();
    return Reflect.construct(RealDate, args.length ? args : [now()], new.target);
  } as any;
  Object.setPrototypeOf(Pinned, RealDate);
  Pinned.prototype = RealDate.prototype;
  Pinned.now = now;
  globalThis.Date = Pinned as DateConstructor;
}
export function unpinClock() {
  globalThis.Date = RealDate;
}
// PGHL_TEST_NOW=2026-06-15T22:30:00Z npx vitest run tests/mobile.test.ts … runs a file at that instant. Pinned when this module loads,
// i.e. before the test file's own top-level `new Date()` (an explicit pinClock in a test wins from then on).
if (process.env.PGHL_TEST_NOW) pinClock(process.env.PGHL_TEST_NOW);

/** The date (YYYY-MM-DD) in Berlin – the default sub-account's zone – `offsetDays` from today. Tests must not take "today" from the UTC date. */
export const berlinDay = (offsetDays = 0, at = new Date()) => addDaysYmd(ymdInTz(at, 'Europe/Berlin'), offsetDays);

export async function startTestApp(overrides: Partial<Config> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pghl-'));
  const instance = createApp(
    { port: 0, host: '127.0.0.1', dataDir: dir, dbFile: join(dir, 'test.db'), baseUrl: 'http://localhost', webDir: join(dir, 'web'), behindProxy: false, tickMs: 0, secret: 'test-secret', ...overrides },
    MODULES,
  );
  const server = await instance.listen();
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  let locationId = '';

  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const r = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-pghl': '1',
        ...(cookie ? { cookie } : {}),
        ...(locationId ? { 'x-location-id': locationId } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = r.headers.get('content-type') ?? '';
    const data = type.includes('json') ? await r.json() : await r.text();
    return { status: r.status, data: data as any, headers: r.headers };
  }

  const api = {
    get: (p: string, h?: Record<string, string>) => call('GET', p, undefined, h),
    post: (p: string, b?: unknown, h?: Record<string, string>) => call('POST', p, b ?? {}, h),
    patch: (p: string, b?: unknown) => call('PATCH', p, b ?? {}),
    put: (p: string, b?: unknown) => call('PUT', p, b ?? {}),
    del: (p: string) => call('DELETE', p),
    raw: (p: string, init?: RequestInit) => fetch(base + p, init),
    setLocation: (l: string) => (locationId = l),
    clearCookie: () => (cookie = ''),
    get location() {
      return locationId;
    },
    get cookie() {
      return cookie;
    },
  };

  async function setup() {
    const r = await api.post('/api/auth/setup', { email: 'chef@example.com', password: 'geheim123', name: 'Chef', locationName: 'Testfirma' });
    if (r.status !== 200) throw new Error(JSON.stringify(r.data));
    const me = await api.get('/api/me');
    api.setLocation(me.data.locations[0].id);
    return me.data;
  }

  return {
    app: instance.app,
    api,
    base,
    setup,
    async close() {
      await instance.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
