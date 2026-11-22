import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';

/**
 * Compact MCP mode: /mcp?tools=compact lists only ghl_search and ghl_execute (a fraction of the context of the full catalogue),
 * search finds tools in German and English, execute runs them with the same checks, rights and scoping as a direct call.
 */

type T = Awaited<ReturnType<typeof startTestApp>>;
let t: T;
let agencyKey = '';
let readKey = '';
let locKey = '';
let A = '';
let B = '';

async function rpc(key: string, method: string, params: unknown, query = '?tools=compact', headers: Record<string, string> = {}) {
  const r = await fetch(`${t.base}/mcp${query}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json()) as any;
}
const call = (name: string, args: unknown, key = agencyKey, query = '?tools=compact') => rpc(key, 'tools/call', { name, arguments: args }, query);
const search = async (query: string, key = agencyKey) => (await call('ghl_search', { query }, key)).result.structuredContent.tools.map((x: any) => x.name) as string[];

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  A = (await t.api.post('/api/locations', { name: 'Kompakt A' })).data.id;
  B = (await t.api.post('/api/locations', { name: 'Kompakt B' })).data.id;
  agencyKey = (await t.api.post('/api/agency/api-keys', { name: 'Kompakt' })).data.key;
  readKey = (await t.api.post('/api/agency/api-keys', { name: 'Kompakt lesen', scope: 'read' })).data.key;
  t.api.setLocation(A);
  locKey = (await t.api.post('/api/api-keys', { name: 'Kompakt A' })).data.key;
});
afterAll(async () => {
  await t?.close();
});

describe('compact MCP mode (search + execute)', () => {
  it('lists two tools instead of the catalogue, by query or header, and says how to use them', async () => {
    const full = (await rpc(agencyKey, 'tools/list', {}, '')).result.tools;
    const compact = (await rpc(agencyKey, 'tools/list', {})).result.tools;
    const viaHeader = (await rpc(agencyKey, 'tools/list', {}, '', { 'x-mcp-tools': 'compact' })).result.tools;
    expect(full.length).toBeGreaterThan(200);
    expect(compact.map((x: any) => x.name)).toEqual(['ghl_search', 'ghl_execute']);
    expect(viaHeader.map((x: any) => x.name)).toEqual(['ghl_search', 'ghl_execute']);
    expect(JSON.stringify(compact).length * 20).toBeLessThan(JSON.stringify(full).length);
    const init = (await rpc(agencyKey, 'initialize', { protocolVersion: '2025-06-18' })).result;
    expect(init.instructions).toMatch(/ghl_search/);
  });

  it('finds tools in German and English, with their schema', async () => {
    expect((await search('kontakt anlegen')).slice(0, 3)).toContain('ghl_upsert_contact');
    expect((await search('create contact')).slice(0, 3)).toContain('ghl_upsert_contact');
    expect((await search('rechnungen liste')).slice(0, 3)).toContain('ghl_list_invoices');
    expect((await search('deal')).some((n) => /opportunit/.test(n))).toBe(true);
    const r = (await call('ghl_search', { query: 'projekte', limit: 2 })).result.structuredContent;
    expect(r.tools.length).toBeLessThanOrEqual(2);
    expect(r.tools[0].inputSchema.type).toBe('object');
    expect((await call('ghl_search', { query: '' })).result.structuredContent.tools).toEqual([]);
  });

  it('runs a tool through ghl_execute with the usual argument checks', async () => {
    const made = await call('ghl_execute', { tool: 'ghl_upsert_contact', arguments: { location_id: A, email: 'kompakt@example.com', first_name: 'Kim' } });
    expect(made.result.isError).toBe(false);
    expect(t.app.db.get('SELECT first_name FROM contacts WHERE location_id = ? AND email = ?', A, 'kompakt@example.com')?.first_name).toBe('Kim');
    const asText = await call('ghl_execute', { tool: 'ghl_search_contacts', arguments: JSON.stringify({ location_id: A, query: 'Kim' }) });
    expect(asText.result.structuredContent.total).toBe(1);
    expect((await call('ghl_execute', { arguments: {} })).error.code).toBe(-32602);
    expect((await call('ghl_execute', { tool: 'ghl_nope' })).error.message).toMatch(/ghl_search/);
    expect((await call('ghl_execute', { tool: 'ghl_execute', arguments: {} })).error.code).toBe(-32602);
    expect((await call('ghl_execute', { tool: 'ghl_search_contacts', arguments: { location_id: A, limit: 'viele' } })).error.code).toBe(-32602);
  });

  it('keeps rights and scoping: read-only keys only read, a sub-account key stays in its sub-account', async () => {
    expect((await call('ghl_execute', { tool: 'ghl_list_projects', arguments: {} }, readKey)).result.isError).toBe(false);
    const write = await call('ghl_execute', { tool: 'ghl_upsert_contact', arguments: { location_id: A, email: 'nein@example.com' } }, readKey);
    expect(write.result.isError).toBe(true);
    const foreign = await call('ghl_execute', { tool: 'ghl_search_contacts', arguments: { location_id: B, query: 'x' } }, locKey);
    expect(foreign.result.isError).toBe(true);
    expect(foreign.result.content[0].text).toMatch(/403/);
    const agencyOnly = (await rpc(agencyKey, 'tools/list', {}, '')).result.tools.find((x: any) => x.name === 'ghl_set_location_plan');
    if (agencyOnly) expect(await search('set_location_plan', locKey)).not.toContain('ghl_set_location_plan');
  });

  it('still answers direct tool calls in compact mode and leaves the normal mode unchanged', async () => {
    expect((await call('ghl_list_projects', {})).result.isError).toBe(false);
    expect((await call('ghl_search', { query: 'kontakt' }, agencyKey, '')).result.isError).toBe(false);
  });
});
