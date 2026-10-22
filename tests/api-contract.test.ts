import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error – plain .mjs script without type declarations
import { markdownFiles } from '../scripts/check-docs.mjs';
import { ROOT } from './boot-fakes.js';
import { startTestApp } from './helpers.js';

/**
 * Contract drift: every route the documentation, the web app and the Android app name must exist on the server with that method
 * (the other direction – every route family is documented – is tests/docs.test.ts). The inventory is the router of a running app,
 * once as installed and once in cloud mode; the demo-mode routes are read from their module. Then the documented request fields
 * that once went nowhere, and the payloads of events that drifted.
 */

type Route = { method: string; pattern: string };
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const segs = (p: string) => p.split('/').filter(Boolean);
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let routes: Route[] = [];
/** A concrete path (`:x`, `<x>` or a "\u0002" hole = any segment) matches a route of that method (HEAD rides on GET). */
const hit = (method: string, path: string) => {
  const parts = segs(path);
  return routes.some((r) => {
    if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) return false;
    const rp = segs(r.pattern);
    if (rp.length !== parts.length) return false;
    return rp.every((x, k) => {
      const d = parts[k];
      if (x.startsWith(':') || x === d || /^<.*>$/.test(d)) return true;
      // a segment built from an expression (`${id}`) or a literal with one in it (`${id}.csv`)
      return d.includes('\u0002') && new RegExp(`^${d.split('\u0002').map(esc).join('.+')}$`).test(x);
    });
  });
};

beforeAll(async () => {
  const plain = await startTestApp();
  const cloud = await startTestApp({ cloudMode: true });
  const list = (t: Awaited<ReturnType<typeof startTestApp>>) => ((t.app.router as any).routes as Route[]).map((r) => ({ method: r.method, pattern: r.pattern }));
  routes = [...list(plain), ...list(cloud)];
  await plain.close();
  await cloud.close();
  // Demo mode seeds a whole demo when it starts; its few routes are read from the module instead.
  for (const m of read('server/modules/demo.ts').matchAll(/router\.(get|post|put|patch|delete)\('(\/api\/[^']+)'/g)) routes.push({ method: m[1].toUpperCase(), pattern: m[2] });
  // The app directory and the push relay run only on the operator's cloud instance (PGHL_APP_DIRECTORY / PGHL_PUSH_RELAY); read them from the modules too.
  for (const f of ['server/modules/app-discovery.ts', 'server/modules/push-relay.ts'])
    for (const m of read(f).matchAll(/router\.(get|post|put|patch|delete)\('(\/api\/[^']+)'/g)) routes.push({ method: m[1].toUpperCase(), pattern: m[2] });
}, 60_000);

// ---------------------------------------------------------------------------------------------------------------------------
// Documentation

/** Route families of other products the pages describe (Cognee, Composio, KIE, OpenShorts) – not ours. */
const EXTERNAL = new Set(['v1', 'v3.1', 'clip', 'subtitle', 'translate', 'config', 'process', 'thumbnail', 'saasshorts']);
const METHOD = '(?:GET|POST|PUT|PATCH|DELETE|HEAD)';
const DOC_ROUTE = new RegExp(`\`(${METHOD}(?:\\s*[/|]\\s*${METHOD})*)\\s+(/api/[^\`\\s]*)\``, 'g');

/** `a[/:id]`, `x(.csv)` → with and without; the query goes. */
function optionals(path: string): string[] {
  let out = [path];
  for (let i = 0; i < 4; i++) out = out.flatMap((v) => { const m = v.match(/\(([^()]*)\)|\[([^[\]]*)\]/); return m ? [v.replace(m[0], ''), v.replace(m[0], m[1] ?? m[2])] : [v]; });
  return [...new Set(out.map((v) => v.replace(/\?.*$/, '').replace(/\\\|/g, '|')))];
}
/** `x/a|b/y` read per segment, or `x/a|b/c` as alternative tails (`/api/cloud/plan|subscribe/confirm`). */
const perSegment = (v: string) => v.split('/').slice(1).reduce<string[]>((acc, s) => acc.flatMap((a) => s.split('|').map((x) => `${a}/${x}`)), ['']);
const tails = (v: string) => { const i = v.indexOf('|'); if (i < 0) return [v]; const cut = v.lastIndexOf('/', i); return v.slice(cut + 1).split('|').map((a) => v.slice(0, cut + 1) + a); };

/** What a `METHODS /api/…` mention promises that the router does not have. */
function docRouteProblems(methods: string[], path: string): string[] {
  const base = optionals(path);
  const check = (expand: (v: string) => string[]) => {
    const variants = [...new Set(base.flatMap(expand))];
    const miss: string[] = [];
    for (const m of methods) if (!variants.some((v) => hit(m, v))) miss.push(`${m} ${path}`);
    for (const v of variants) if (!methods.some((m) => hit(m, v))) miss.push(`${methods.join('/')} ${v}`);
    // `GET/PATCH/DELETE /api/x/:id` without optional parts: every method on every path
    if (base.length === 1) for (const m of methods) for (const v of variants) if (!hit(m, v)) miss.push(`${m} ${v}`);
    return [...new Set(miss)];
  };
  const a = check(perSegment);
  const b = check(tails);
  return a.length <= b.length ? a : b;
}

describe('the documentation names only routes that exist', () => {
  it('every `METHOD /api/…` in docs/ and the READMEs is a route with that method', () => {
    const files = [...markdownFiles().filter((f: string) => /^docs\/[^/]+\.md$/.test(f)), 'README.md', 'README.de.md'];
    const families = new Set(routes.map((r) => segs(r.pattern)[1]));
    const found: string[] = [];
    let n = 0;
    for (const f of files)
      read(f)
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.matchAll(DOC_ROUTE)) {
            const path = m[2];
            if (/[{}…]/.test(path)) continue; // placeholders of other APIs, paths relative to the one before
            const family = segs(path)[1].replace(/[[(?].*$/, '');
            if (EXTERNAL.has(family)) continue;
            n++;
            if (!families.has(family)) found.push(`${f}:${i + 1} unknown family /api/${family}`);
            else for (const p of docRouteProblems(m[1].split(/\s*[/|]\s*/), path)) found.push(`${f}:${i + 1} ${p}`);
          }
        });
    expect(n, 'the parser still finds the documented routes').toBeGreaterThan(1500);
    expect(found, 'documented, but the server has no such route – fix the page (or the route)').toEqual([]);
  });

  it('the checker itself: shorthand, optional parts and alternatives', () => {
    expect(docRouteProblems(['GET', 'PATCH', 'DELETE'], '/api/tasks/:id')).toEqual(['GET /api/tasks/:id']);
    expect(docRouteProblems(['PATCH', 'DELETE'], '/api/tasks/:id')).toEqual([]);
    expect(docRouteProblems(['GET', 'DELETE'], '/api/agent/memory[/:id]?agent_id=')).toEqual([]);
    expect(docRouteProblems(['POST'], '/api/ab-tests/:id/start\\|pause\\|end')).toEqual([]);
    expect(docRouteProblems(['POST'], '/api/ab-tests/:id/start\\|gibtsnicht')).toEqual(['POST /api/ab-tests/:id/gibtsnicht']);
    expect(docRouteProblems(['PATCH'], '/api/campaigns')).toEqual(['PATCH /api/campaigns']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Web app and Android app

/** A JS string or template literal at `i` with every `${…}` replaced by "\u0000expr\u0001". */
function literalAt(src: string, i: number): string {
  const q = src[i];
  let out = '';
  for (let j = i + 1; j < src.length; ) {
    const c = src[j];
    if (c === '\\') (out += src[j + 1]), (j += 2);
    else if (c === q) return out;
    else if (q === '`' && c === '$' && src[j + 1] === '{') {
      let depth = 1;
      let expr = '';
      for (j += 2; j < src.length && depth; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        if (depth) expr += src[j];
      }
      out += `\u0000${expr}\u0001`;
    } else (out += c), j++;
  }
  return out;
}
/** The path part of a literal: expressions that build a query string end it, others are one segment ("\u0002"). */
function pathOf(lit: string): string {
  const p = lit.replace(/\u0000([^\u0001]*)\u0001/g, (_, expr: string) => (/['"`]\?|^\s*(qs|query|params|search|q)\s*$|URLSearchParams|toString\(\)|^\s*(q|qs|query)\(/.test(expr) ? '\u0003' : '\u0002'));
  const cut = p.search(/[?#\u0003]/);
  return cut < 0 ? p : p.slice(0, cut);
}

describe('the web app calls only routes that exist', () => {
  it('every api.get/post/put/patch/del("/api/…") in web/src matches a route with that method', () => {
    const files = execFileSync('git', ['ls-files', 'web/src'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((f) => /\.tsx?$/.test(f));
    const VERB: Record<string, string> = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', del: 'DELETE' };
    const found: string[] = [];
    let n = 0;
    for (const f of files) {
      const src = read(f);
      const calls = [
        ...[...src.matchAll(/\bapi\.(get|post|patch|put|del)(?:<[^>]*>)?\(\s*(['"`])/g)].map((m) => ({ at: m.index! + m[0].length - 1, method: VERB[m[1]], index: m.index! })),
        ...[...src.matchAll(/\bapi\.text\(\s*'(GET|POST|PUT|PATCH|DELETE)',\s*(['"`])/g)].map((m) => ({ at: m.index! + m[0].length - 1, method: m[1], index: m.index! })),
      ];
      for (const c of calls) {
        const lit = literalAt(src, c.at);
        if (!lit.startsWith('/api/')) continue; // a path built elsewhere
        n++;
        if (!hit(c.method, pathOf(lit))) found.push(`${f}:${src.slice(0, c.index).split('\n').length} ${c.method} ${lit.replace(/\u0000/g, '${').replace(/\u0001/g, '}')}`);
      }
    }
    expect(n, 'the parser still finds the calls').toBeGreaterThan(1500);
    expect(found, 'the web app calls a route the server does not have').toEqual([]);
  });
});

describe('the Android app calls only routes that exist', () => {
  it('every endpoint of GoHighApi.kt is a route with that method (and a mobile one)', () => {
    const src = read('android/app/src/main/java/org/gohigh/android/api/GoHighApi.kt');
    const found: string[] = [];
    let n = 0;
    for (const line of src.split('\n')) {
      const path = line.match(/"(api\/[^"]+)"/)?.[1];
      if (!path) continue;
      const methods = /\bsend\(/.test(line) ? [...line.slice(0, line.indexOf(`"${path}"`)).matchAll(/"(GET|POST|PUT|PATCH|DELETE)"/g)].map((m) => m[1]) : /\bget\(/.test(line) ? ['GET'] : [];
      expect(methods.length, line.trim()).toBeGreaterThan(0);
      const extra = (line.slice(line.indexOf(`"${path}"`)).match(/listOf\(([^)]*)\)/)?.[1] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => (s.startsWith('"') ? s.slice(1, -1) : ':param'));
      const full = `/${[path, ...extra].join('/')}`;
      for (const m of methods) {
        n++;
        if (!full.startsWith('/api/mobile/')) found.push(`${m} ${full} is not under /api/mobile (the device token only works there)`);
        if (!hit(m, full)) found.push(`${m} ${full}`);
      }
    }
    expect(n).toBeGreaterThan(35);
    expect(found).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Request fields and event payloads that drifted

describe('documented request fields and event payloads', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  let key = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await t.api.raw(path, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: (await r.json()) as any };
  };
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
    key = (await t.api.post('/api/api-keys', { name: 'Vertrag' })).data.key;
  });
  afterAll(() => t.close());

  it('appointments take start_at/end_at as the OpenAPI description says (and start/end as the app sends)', async () => {
    const cal = (await call('POST', '/api/calendars', { name: 'Beratung' })).data;
    const contact = (await call('POST', '/api/contacts', { first_name: 'Anna', email: 'anna@example.com' })).data;
    const start = new Date(Date.now() + 3 * 86_400_000);
    start.setUTCHours(9, 0, 0, 0);
    const made = await call('POST', '/api/appointments', { calendar_id: cal.id, contact_id: contact.id, start_at: start.toISOString(), force: true });
    expect(made.status, JSON.stringify(made.data)).toBe(200);
    expect(made.data.start_at).toBe(start.toISOString());
    const length = Date.parse(made.data.end_at) - Date.parse(made.data.start_at);

    const later = new Date(start.getTime() + 86_400_000);
    const moved = await call('PATCH', `/api/appointments/${made.data.id}`, { start_at: later.toISOString() });
    expect(moved.data.start_at).toBe(later.toISOString());
    expect(Date.parse(moved.data.end_at) - Date.parse(moved.data.start_at), 'the length stays').toBe(length);
    const end = new Date(later.getTime() + 2 * 3_600_000);
    expect((await call('PATCH', `/api/appointments/${made.data.id}`, { end_at: end.toISOString() })).data).toMatchObject({ start_at: later.toISOString(), end_at: end.toISOString() });
    expect((await call('PATCH', `/api/appointments/${made.data.id}`, { start: start.toISOString(), end: later.toISOString() })).data).toMatchObject({ start_at: start.toISOString(), end_at: later.toISOString() });
    const backwards = await call('PATCH', `/api/appointments/${made.data.id}`, { end_at: new Date(start.getTime() - 60_000).toISOString() });
    expect(backwards).toMatchObject({ status: 400, data: { error: 'Das Ende muss nach dem Beginn liegen' } });

    const blocked = await call('POST', '/api/appointments', { calendar_id: cal.id, blocked: true, title: 'Urlaub', start_at: start.toISOString(), end_at: end.toISOString() });
    expect(blocked.data).toMatchObject({ status: 'blocked', title: 'Urlaub', start_at: start.toISOString(), end_at: end.toISOString() });
  });

  it('the public booking takes the name the way the OpenAPI description offers it', async () => {
    const cal = (await call('POST', '/api/calendars', { name: 'Erstgespräch' })).data;
    const slots = (await t.api.get(`/api/public/calendars/${cal.slug}/slots?days=14`)).data;
    const start = slots.days.flatMap((d: { slots: string[] }) => d.slots)[0];
    expect(start, JSON.stringify(slots).slice(0, 200)).toBeTruthy();
    const r = await t.api.raw(`/api/public/calendars/${cal.slug}/book`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ start, name: 'Dora Muster', email: 'dora@example.com' }) });
    expect(r.status).toBe(200);
    const contact = (await call('GET', '/api/contacts?q=dora@example.com')).data.contacts[0];
    expect(contact).toMatchObject({ first_name: 'Dora', last_name: 'Muster' });
  });

  it('the OpenAPI bodies of tasks and appointments list only what the handlers read', async () => {
    const spec = (await (await t.api.raw('/api/openapi.json')).json()) as any;
    const props = (s: any) => Object.keys((s.$ref ? spec.components.schemas[s.$ref.split('/').pop()] : s).properties).sort();
    const body = (path: string, m: string) => spec.paths[path][m].requestBody.content['application/json'].schema;
    expect(props(body('/api/tasks', 'post'))).not.toContain('done');
    expect(props(body('/api/tasks/{id}', 'patch'))).not.toContain('contact_id');
    expect(props(body('/api/tasks/{id}', 'patch'))).toContain('done');
    expect(props(body('/api/appointments', 'post'))).toContain('start_at');
    expect(body('/api/appointments', 'post').required).toEqual(['calendar_id', 'start_at']);
  });

  it('deleting contacts in bulk reports each one as contact.deleted, like the single delete', async () => {
    const ids = [];
    for (const n of ['Bea', 'Carl']) ids.push((await call('POST', '/api/contacts', { first_name: n, email: `${n.toLowerCase()}@example.com` })).data.id);
    const seen: string[] = [];
    t.app.events.on('contact.deleted', (e) => void seen.push(e.data.contactId));
    expect((await call('POST', '/api/contacts/bulk', { action: 'delete', ids })).data).toEqual({ count: 2 });
    await t.app.events.flush();
    expect(seen.sort()).toEqual([...ids].sort());
  });

  it('task.updated carries the task (not its id) also when a dependency is added', async () => {
    const project = (await t.api.post('/api/pm/projects', { name: 'Vertragstest' })).data;
    const a = (await t.api.post('/api/pm/tasks', { title: 'Erst', project_id: project.id })).data;
    const b = (await t.api.post('/api/pm/tasks', { title: 'Dann', project_id: project.id })).data;
    const events: any[] = [];
    t.app.events.on('task.updated', (e) => void events.push(e.data));
    expect((await t.api.post(`/api/pm/tasks/${b.id}/dependencies`, { depends_on: a.id })).status).toBe(200);
    await t.app.events.flush();
    const dep = events.find((d) => d.changed?.includes('dependencies'));
    expect(dep).toMatchObject({ task: { id: b.id, title: 'Dann' }, projectId: project.id, changed: ['dependencies'] });
  });
});
