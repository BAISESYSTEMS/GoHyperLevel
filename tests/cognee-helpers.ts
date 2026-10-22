import { clearTokens } from '../server/services/cognee/client.js';
import { client, type Call } from './security-fixtures.js';
import { startTestApp } from './helpers.js';
import { fakeCognee, type FakeOptions } from './cognee-fakes.js';

/** An app with a fake Cognee server behind it: no network, no waiting, a clock the test moves. */
export async function cogneeApp(opts: { fake?: FakeOptions } = {}) {
  clearTokens();
  const t = await startTestApp();
  const me = await t.setup();
  let clock = Date.now();
  const fake = fakeCognee({ ...opts.fake, now: () => clock });
  const s = t.app.services;
  s.cogneeFetch = fake.fetch;
  s.cogneeSleep = async () => undefined;
  s.cogneeGapMs = 0;
  s.cogneeNow = () => clock;
  const A = t.api.location;
  const admin = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1' });
  /** A call in a sub-account as the signed-in agency admin. */
  const at = (loc: string): Call => (m, p, b, h) => admin(m, p, b, { 'x-location-id': loc, ...h });
  const body = (over: Record<string, unknown> = {}) => ({ base_url: 'http://cognee:8000', auth_mode: 'password', email: 'gohigh@example.com', password: 'pw-gohigh', allow_private: true, ...over });
  return {
    t,
    fake,
    A,
    admin,
    at,
    adminId: me.user.id as string,
    now: () => clock,
    advance: (ms: number) => void (clock += ms),
    connect: async (over: Record<string, unknown> = {}) => {
      const r = await admin('PUT', '/api/agency/cognee', body(over));
      if (r.status !== 200) throw new Error(`connect: ${r.status} ${r.text}`);
      return r;
    },
    /** Switches a sub-account's sharing on with these types and runs the sync until it is idle. */
    share: async (loc: string, types: Record<string, boolean> = {}, extra: Record<string, unknown> = {}) => {
      const r = await at(loc)('PUT', '/api/cognee/admin/settings', { enabled: true, types, ...extra });
      if (r.status !== 200) throw new Error(`share: ${r.status} ${r.text}`);
      await t.app.services.cognee.idle();
      await t.app.services.cognee.syncUntilIdle(loc);
      return r;
    },
    sync: (loc: string, opts?: { full?: boolean }) => t.app.services.cognee.syncUntilIdle(loc, opts),
    idle: () => t.app.services.cognee.idle(),
    close: async () => {
      await t.app.services.cognee.idle();
      await t.close();
    },
  };
}

export type CogneeApp = Awaited<ReturnType<typeof cogneeApp>>;

/** Dataset names a call touched (path, query or body carries a dataset id of the fake), by sub-account. */
export function touchedLocations(fake: ReturnType<typeof fakeCognee>, calls = fake.calls): Set<string> {
  const byId = new Map([...fake.datasets.values()].map((d) => [d.id, d.name]));
  const out = new Set<string>();
  const scan = (text: string) => {
    for (const [id, name] of byId) if (text.includes(id)) out.add(/^gh_([A-Za-z0-9]+)_/.exec(name)?.[1] ?? name);
  };
  for (const c of calls) scan(`${c.path} ${JSON.stringify(c.query)} ${JSON.stringify(c.body ?? '')}`);
  return out;
}
