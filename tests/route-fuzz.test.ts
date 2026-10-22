import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestApp } from './helpers.js';
import { installOutboundGuard, uninstallOutboundGuard } from '../server/services/outbound-guard.js';

/**
 * Robustness sweep over every registered route: a request with a missing, empty or wrongly typed body, nonsense path
 * parameters or a malformed percent-escape must be answered with a 4xx – never with a 500 ("Interner Fehler"), which is
 * what an unguarded `ctx.body.x.trim()` or a `JSON.parse` of a user value produces. Outgoing connections are blocked for
 * the run, so routes that call other services just fail like a network error.
 */
interface Hit {
  where: string;
  status: number;
  why: string;
}

/**
 * Routes that would end the session or replace the whole database mid-run (they are not input-validation questions), and the HubSpot token
 * check, whose client retries a failed connection with real pauses (longer than this sweep waits for an answer).
 */
const SKIP = /\/api\/import\/hubspot\/connection|\/api\/auth\/(logout|setup|password|login)|\/api\/admin\/(restore|reset|wipe)|\/api\/demo\/|\/api\/backups\/.*restore|\/api\/data\/import|\/api\/setup/;

const PAYLOADS: { name: string; body: unknown }[] = [
  { name: 'empty', body: {} },
  { name: 'null', body: null },
];

/** A body whose every likely field is the wrong type (number / object / array / null / huge string). */
const fieldNames = ['name', 'title', 'email', 'phone', 'url', 'text', 'body', 'subject', 'status', 'type', 'kind', 'id', 'contactId', 'contact_id', 'items', 'steps', 'settings', 'data', 'config', 'value', 'date', 'start', 'end', 'from', 'to', 'tags', 'amount', 'amount_cents', 'currency', 'password', 'token', 'code', 'description', 'content', 'html', 'language', 'timezone', 'filters', 'definition', 'ids', 'list', 'rules', 'fields', 'options', 'mapping', 'csv', 'file', 'filename', 'mime', 'size', 'content_type', 'enabled', 'active'];
const wrongBodies = (): { name: string; body: unknown }[] => {
  const mk = (v: unknown) => Object.fromEntries(fieldNames.map((k) => [k, v]));
  const all = [
    { name: 'all-numbers', body: mk(12345) },
    { name: 'all-objects', body: mk({ a: { b: 1 } }) },
    { name: 'all-arrays', body: mk([1, [2], { x: 3 }]) },
    { name: 'all-null', body: mk(null) },
    { name: 'all-long', body: mk('x'.repeat(5000)) },
  ];
  // The quick run (default) tries the nastiest three; FUZZ_DEEP=1 (and real parent records) tries them all.
  return process.env.FUZZ_DEEP ? all : [all[1], all[2], all[3]];
};

describe('route fuzz: bad input is never a 500', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  const hits: Hit[] = [];
  let routes: { method: string; pattern: string; auth: string }[] = [];
  const errors: string[] = [];

  beforeAll(async () => {
    installOutboundGuard();
    t = await startTestApp();
    await t.setup();
    routes = ((t.app.router as any).routes as { method: string; pattern: string; auth: string }[]).filter((r) => !SKIP.test(r.pattern));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : String(x))).join(' ').slice(0, 300)));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  }, 60_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    await t.close();
    uninstallOutboundGuard();
  });

  const fill = (pattern: string, v: string) => pattern.replace(/:[A-Za-z_]+/g, v);
  /** Real parent records: POST to the collection a route lives under, so the sub-routes get past the 404 and reach their validation. */
  const parents = new Map<string, string>();
  const parentId = async (pattern: string): Promise<string> => {
    const prefix = pattern.split('/:')[0];
    if (!pattern.includes('/:') || !prefix) return 'nope-id';
    if (parents.has(prefix)) return parents.get(prefix)!;
    parents.set(prefix, 'nope-id');
    const create = routes.find((r) => r.method === 'POST' && r.pattern === prefix && r.auth !== 'public');
    if (create) {
      for (const body of [{ name: 'Fuzz', title: 'Fuzz', label: 'Fuzz', first_name: 'Fuzz', email: 'fuzz@example.com' }]) {
        try {
          const r = await fetch(t.base + prefix, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pghl': '1', cookie: t.api.cookie, 'x-location-id': t.api.location }, body: JSON.stringify(body) });
          const j: any = await r.json().catch(() => ({}));
          const got = j?.id ?? j?.data?.id;
          if (r.status < 300 && typeof got === 'string') parents.set(prefix, got);
        } catch {
          /* no parent */
        }
      }
    }
    return parents.get(prefix)!;
  };

  it('answers every malformed request with a client error', async () => {
    const cookie = t.api.cookie;
    const loc = t.api.location;
    const send = async (method: string, path: string, auth: string, rawBody?: string, headers: Record<string, string> = {}) => {
      errors.length = 0;
      let r: Response;
      try {
        r = await fetch(t.base + path, {
          method,
          headers: { 'content-type': 'application/json', 'x-pghl': '1', ...(auth !== 'public' ? { cookie, 'x-location-id': loc } : {}), ...headers },
          body: method === 'GET' || method === 'HEAD' ? undefined : rawBody,
          redirect: 'manual',
          signal: AbortSignal.timeout(15_000),
        });
        await r.arrayBuffer().catch(() => undefined);
      } catch (e) {
        return void hits.push({ where: `${method} ${path}`, status: 0, why: `fetch failed: ${(e as Error).message}` });
      }
      if (r.status >= 500 && r.status !== 501 && r.status !== 502 && r.status !== 503 && r.status !== 504) hits.push({ where: `${method} ${path} ${rawBody ? rawBody.slice(0, 40) : ''}`, status: r.status, why: errors[0] ?? '' });
    };
    for (const rt of routes) {
      const pid = process.env.FUZZ_DEEP ? await parentId(rt.pattern) : 'nope-id';
      const real = rt.pattern.replace(/:[A-Za-z_]+/, pid).replace(/:[A-Za-z_]+/g, 'nope-id');
      const weird = fill(rt.pattern, '%E0%A4%A');
      for (const p of [...PAYLOADS, ...wrongBodies()]) {
        if (rt.method === 'GET') {
          if (p.name === 'empty') await send('GET', real, rt.auth);
          continue;
        }
        await send(rt.method, real, rt.auth, JSON.stringify(p.body));
      }
      await send(rt.method, real, rt.auth, '{"broken": ');
      if (rt.method === 'GET') await send('GET', real + '?limit=abc&offset=-5&from=zzz&to=1&q=%00&page=-1', rt.auth);
      await send(rt.method, weird, rt.auth, '{}');
    }
    const report = hits.map((h) => `${h.status} ${h.where}  ←  ${h.why.replace(/^\[request \w+\] /, '')}`);
    if (process.env.FUZZ_OUT) (await import('node:fs')).writeFileSync(process.env.FUZZ_OUT, report.join('\n'));
    // eslint-disable-next-line no-console
    process.stdout.write(`\nROUTES ${routes.length}  HITS ${hits.length}\n${report.join('\n')}\n`);
    expect(hits.length, report.slice(0, 40).join('\n')).toBe(0);
  }, 900_000);
});
