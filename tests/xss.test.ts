import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Route } from '../server/core/http.js';
import { startTestApp } from './helpers.js';
import { sha256 } from '../server/core/util.js';
import { client, seedLocation, tableColumns } from './security-fixtures.js';

/**
 * Stored-XSS sweep over every public server-rendered page: all names and texts of a sub-account carry
 * a payload with quotes and a tag, then every public GET route is opened with every id/slug/token the
 * database holds. The raw tag must never appear – only its escaped form. Funnel/blog pages (owner code,
 * sandboxed by CSP) are checked for the sandbox header instead of escaping.
 */

const PAYLOAD = `Xss"'><x-xss>`;
let t: Awaited<ReturnType<typeof startTestApp>>;
let L = '';
const realFetch = globalThis.fetch;

beforeAll(async () => {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error(`offline in tests: ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
  t = await startTestApp();
  await t.setup();
  L = t.api.location;
  const admin = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1' });
  await admin('PATCH', '/api/location', { name: PAYLOAD }, { 'x-location-id': L });
  await admin('PUT', '/api/helpdesk/settings', { help_center: { enabled: true, title: PAYLOAD, intro: PAYLOAD }, portal: { enabled: true, any_contact: true } }, { 'x-location-id': L });
  const s = await seedLocation(admin, L, PAYLOAD);
  // Some steps reject the payload on purpose (keys, slugs); the rest must have worked.
  console.log('xss seed skipped:', s.failed);
  expect(s.failed.length, s.failed.join('\n')).toBeLessThan(6);
  // Public flavours of the records: published article, sent contract, review request, booking.
  t.app.db.run(`UPDATE kb_articles SET status = 'published' WHERE location_id = ?`, L);
  const contract = t.app.db.get(`SELECT id FROM contracts WHERE location_id = ?`, L);
  if (contract) await admin('POST', `/api/contracts/${contract.id}/send`, { contact_id: t.app.db.get('SELECT id FROM contacts WHERE location_id = ?', L)?.id }, { 'x-location-id': L });
  const contact = t.app.db.get('SELECT id FROM contacts WHERE location_id = ?', L);
  await admin('POST', '/api/reviews/request', { contact_id: contact?.id }, { 'x-location-id': L });
  const inv = t.app.db.get(`SELECT id FROM invoices WHERE location_id = ?`, L);
  if (inv) await admin('POST', `/api/invoices/${inv.id}/send`, {}, { 'x-location-id': L });
}, 120_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await t?.close();
});

/** Every value a public URL could be built from (ids, slugs, tokens, keys, numbers), per table. */
function urlValues(): Map<string, string[]> {
  const out = new Map<string, string[]>([['locations', [L]]]);
  for (const [table, cols] of tableColumns(t.app)) {
    const wanted = cols.filter((c) => c === 'id' || c === 'slug' || c === 'key' || c === 'handle' || c === 'number' || /token$/.test(c) || c === 'file');
    if (!wanted.length) continue;
    const vals = new Set<string>(out.get(table) ?? []);
    for (const r of t.app.db.all(`SELECT ${wanted.map((c) => `"${c}"`).join(', ')} FROM "${table}" LIMIT 50`)) for (const c of wanted) if (r[c] !== null && r[c] !== undefined && String(r[c]).length < 120) vals.add(String(r[c]));
    if (vals.size) out.set(table, [...vals]);
  }
  return out;
}

const norm = (x: string) => x.toLowerCase().replace(/[^a-z]/g, '').replace(/(ies)$/, 'y').replace(/(es|s)$/, '');
const ALIAS: Record<string, string[]> = { p: ['locations', 'course_portals'], loc: ['locations'], slug: ['locations'], a: ['k', 'kb_articles', 'kb_categories'], b: ['kb_articles', 'kb_categories'], n: ['tickets'], who: ['contacts'], handle: ['community_profiles', 'community_members', 'contacts'] };

function paramValues(byTable: Map<string, string[]>, route: Route, i: number): string[] {
  const name = route.parts[i].slice(1);
  const prev = route.parts[i - 1] ?? '';
  const hints = [name.replace(/(Id|_id)$/, ''), ...(/^(id|token|slug|key)$/.test(name) ? [prev] : [])].map(norm).filter((h) => h.length >= 3);
  const out = new Set<string>();
  for (const a of ALIAS[name] ?? []) {
    if (!byTable.has(a)) out.add(a);
    for (const v of byTable.get(a) ?? []) out.add(v);
  }
  for (const [table, vals] of byTable) if (hints.some((h) => norm(table).includes(h) || h.includes(norm(table)))) for (const v of vals) out.add(v);
  if (!out.size) for (const vals of byTable.values()) for (const v of vals) out.add(v);
  return [...out];
}

function* combos(lists: string[][], max: number): Generator<string[]> {
  const idx = lists.map(() => 0);
  for (let n = 0; n < max; n++) {
    yield idx.map((k, j) => lists[j][k]);
    let j = lists.length - 1;
    while (j >= 0 && ++idx[j] >= lists[j].length) idx[j--] = 0;
    if (j < 0) return;
  }
}

describe('public pages escape stored content', () => {
  it('no public page renders the payload unescaped', { timeout: 300_000 }, async () => {
    const routes = ((t.app.router as any).routes as Route[]).filter((r) => r.auth === 'public' && r.method === 'GET');
    const byTable = urlValues();
    // Signed-in visitors too: a portal member (courses, community, tickets) and an affiliate.
    const contact = t.app.db.get('SELECT id FROM contacts WHERE location_id = ? ORDER BY created_at', L)!;
    t.app.db.run(`UPDATE courses SET status = 'published' WHERE location_id = ?`, L);
    t.app.db.insert('member_sessions', { token_hash: sha256('member-raw'), location_id: L, contact_id: contact.id, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 864e5).toISOString() });
    const aff = t.app.db.get('SELECT id, program_id FROM affiliates WHERE location_id = ?', L);
    if (aff) t.app.db.insert('affiliate_sessions', { token_hash: sha256('aff-raw'), affiliate_id: aff.id, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 864e5).toISOString() });
    const visitors = [client(t.base), client(t.base, { cookie: `pm_${L}=member-raw${aff ? `; pa_${aff.program_id}=aff-raw` : ''}` })];
    const hits: string[] = [];
    const sandboxed: string[] = [];
    let pages = 0;
    const withPayload = new Set<string>();
    for (const r of routes) {
      const slots = r.parts.map((p, i) => (p.startsWith(':') ? paramValues(byTable, r, i) : null));
      const lists = slots.filter((x): x is string[] => !!x);
      for (const vals of lists.length ? combos(lists, 2500) : [[]]) {
        let k = 0;
        const path = '/' + r.parts.map((p, i) => (slots[i] ? encodeURIComponent(vals[k++]) : p)).join('/');
        for (const anon of visitors) {
          const res = await anon('GET', path);
          if (res.status >= 400 || !String(res.headers.get('content-type')).includes('html')) continue;
          pages++;
          if (res.text.includes('x-xss')) withPayload.add(r.pattern);
          if (!res.text.includes('<x-xss>')) continue;
          const csp = res.headers.get('content-security-policy') ?? '';
          if (/(^|;)\s*sandbox\b/.test(csp) && !/allow-same-origin/.test(csp)) sandboxed.push(`${r.pattern}`);
          else hits.push(`${r.pattern} (${path}): …${res.text.slice(Math.max(0, res.text.indexOf('<x-xss>') - 100), res.text.indexOf('<x-xss>') + 10)}`);
        }
      }
    }
    console.log(`xss sweep: ${pages} public HTML pages checked, ${withPayload.size} routes rendered the payload: ${[...withPayload].join(' ')}; owner-code pages (sandboxed): ${[...new Set(sandboxed)].join(', ') || '–'}`);
    expect(withPayload.size).toBeGreaterThan(15);
    expect([...new Set(hits)]).toEqual([]);
  });
});
