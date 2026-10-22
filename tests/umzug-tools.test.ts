import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOURCE_KEYS } from '../server/services/umzug-core.js';
import { startTestApp } from './helpers.js';
import { FakeMailchimp, MC_KEY } from './umzug-fakes.js';
import { UMZUG_TOOLS } from '../server/modules/umzug-tools.js';
import { classify, routeProblem } from '../server/services/agent-safety.js';
import { groupOf } from '../server/services/agent-tools.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let other = '';
let keyA = '';
let agencyKey = '';
let agencyRead = '';
const fake = new FakeMailchimp();
let id = 0;
const mcp = async (name: string, args: any, key = keyA) => {
  const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
  const j: any = await r.json();
  const text = j.result?.content?.[0]?.text ?? '';
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* error text */
  }
  return { isError: !!j.result?.isError, text, data };
};

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  other = (await t.api.post('/api/locations', { name: 'Zweite Firma' })).data.id;
  keyA = (await t.api.post('/api/api-keys', { name: 'Umzug A' })).data.key;
  agencyKey = (await t.api.post('/api/agency/api-keys', { name: 'Agentur' })).data.key;
  agencyRead = (await t.api.post('/api/agency/api-keys', { name: 'Nur lesen', scope: 'read' })).data.key;
  t.app.services.umzugFetch = fake.fetch;
  t.app.services.umzugSleep = async () => undefined;
  t.app.services.umzugPauseMs = 0;
  expect((await t.api.put('/api/umzug/connections/mailchimp', { api_key: MC_KEY })).status).toBe(200);
});
afterAll(() => t.close());

describe('MCP tools', () => {
  it('are listed with German descriptions, grouped for the agent, and classified by what they do', () => {
    expect(UMZUG_TOOLS.map((x) => x.name)).toEqual(['ghl_umzug_sources', 'ghl_umzug_preview', 'ghl_umzug_start', 'ghl_umzug_status', 'ghl_mail_domain_check']);
    for (const tool of UMZUG_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(80);
      expect(groupOf(tool.name)).toBe('Umzug & Zustellung');
    }
    // a real import needs a click; the dry run, the preview and the check only read – and the agent may POST to exactly those routes
    const [sources, preview, start, , check] = UMZUG_TOOLS;
    expect([sources, preview, check].map((x) => classify(x))).toEqual(['read', 'read', 'read']);
    expect(classify(start)).toBe('sensitive');
    expect(start.klassFor!({ dry_run: true })).toBe('read');
    expect(start.klassFor!({})).toBe('write');
    for (const path of ['/api/umzug/preview', '/api/umzug/dry-run', '/api/mail-domains/check']) expect(routeProblem('POST', path, 'read'), path).toBeNull();
    expect(routeProblem('POST', '/api/umzug/jobs', 'read')).not.toBeNull();
  });

  it('sources: what comes along, what does not, and whether the connection is there', async () => {
    const r = await mcp('ghl_umzug_sources', {}, agencyKey);
    expect(r.isError).toBe(true);
    const ok = await mcp('ghl_umzug_sources', { location_id: loc }, agencyKey);
    // The tool lists what the registry holds – a new source needs no edit here.
    expect(ok.data.sources.map((s: any) => s.key)).toEqual([...SOURCE_KEYS]);
    expect(SOURCE_KEYS.slice(0, 7)).toEqual(['mailchimp', 'activecampaign', 'kit', 'kajabi', 'teachable', 'keap', 'pipedrive']);
    const mc = ok.data.sources.find((s: any) => s.key === 'mailchimp');
    expect(mc.connected).toBe(true);
    expect(mc.does_not_move.join(' ')).toContain('Automationen');
    expect(ok.text).not.toContain(MC_KEY);
    // a key bound to one sub-account needs no location_id but may not name another one
    expect((await mcp('ghl_umzug_sources', {}, keyA)).data.sources.find((s: any) => s.key === 'mailchimp').connected).toBe(true);
    expect((await mcp('ghl_umzug_sources', { location_id: other }, keyA)).isError).toBe(true);
  });

  it('preview, dry run, import and status through the tools', async () => {
    const p = await mcp('ghl_umzug_preview', { source: 'mailchimp', parts: ['contacts', 'templates'] }, keyA);
    expect(p.isError, p.text).toBe(false);
    expect(p.data.counts.join(' ')).toContain('Audiences (Listen): 2');
    expect(p.data.field_mapping.join('\n')).toContain('E-Mail → email');
    expect(p.data.new_custom_fields).toBeGreaterThan(0);

    const dry = await mcp('ghl_umzug_start', { source: 'mailchimp', parts: ['contacts'], dry_run: true }, keyA);
    expect(dry.data.started.kind).toBe('Probelauf');
    await t.app.services.umzug.idle();
    expect(t.app.db.get<any>('SELECT COUNT(*) n FROM contacts WHERE location_id = ?', loc)!.n).toBe(0);

    const run = await mcp('ghl_umzug_start', { source: 'mailchimp', parts: ['contacts', 'templates'], options: { tag: 'Aus Mailchimp' } }, keyA);
    expect(run.isError, run.text).toBe(false);
    await t.app.services.umzug.idle();
    const st = await mcp('ghl_umzug_status', { job_id: run.data.started.id }, keyA);
    expect(st.data).toMatchObject({ status: 'done', kind: 'Import', percent: 100 });
    expect(st.data.report.join(' ')).toContain('Kontakte: 5 neu');
    expect(st.data.steps.every((s: string) => s.startsWith('✓'))).toBe(true);
    const latest = await mcp('ghl_umzug_status', {}, keyA);
    expect(latest.data.id).toBe(run.data.started.id);
    const tagged = t.app.db.get<any>('SELECT tags FROM contacts WHERE location_id = ? AND email = ?', loc, 'ben@example.com')!.tags;
    expect(JSON.parse(tagged)).toContain('Aus Mailchimp');
    // writes by tools are in the audit log
    const log = t.app.db.all<any>(`SELECT action FROM audit_log WHERE action LIKE 'umzug.%' ORDER BY at`).map((r) => r.action);
    expect(log).toEqual(expect.arrayContaining(['umzug.dryrun.start', 'umzug.dryrun.done', 'umzug.import.start', 'umzug.import.done']));
  });

  it('a read-only agency key cannot start, a key of another sub-account sees nothing of this one', async () => {
    const denied = await mcp('ghl_umzug_start', { location_id: loc, source: 'mailchimp', dry_run: true }, agencyRead);
    expect(denied.isError).toBe(true);
    const status = await mcp('ghl_umzug_status', { location_id: other }, agencyKey);
    expect(status.data).toMatchObject({ jobs: 0 });
    // the connection of this sub-account is not usable from the other one
    const pv = await mcp('ghl_umzug_preview', { location_id: other, source: 'mailchimp' }, agencyKey);
    expect(pv.isError).toBe(true);
    expect(pv.text).toContain('verbinden');
  });

  it('tools never take credentials: connecting is a UI-only route', async () => {
    const viaKey = await t.api.raw('/api/umzug/connections/mailchimp', { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${keyA}`, 'x-location-id': loc }, body: JSON.stringify({ api_key: MC_KEY }) });
    expect(viaKey.status).toBe(403);
    const viaAgency = await t.api.raw('/api/umzug/connections/mailchimp', { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${agencyKey}`, 'x-location-id': loc }, body: JSON.stringify({ api_key: MC_KEY }) });
    expect(viaAgency.status).toBe(403);
    for (const tool of UMZUG_TOOLS) expect(JSON.stringify(tool.inputSchema)).not.toMatch(/api_key|token|secret/i);
  });

  it('ghl_mail_domain_check: status, German steps and records to copy', async () => {
    t.app.services.mailDns = {
      resolveTxt: async (n: string) => (n === 'kunde.de' ? [['v=spf1 mx ~all']] : []),
      resolveMx: async (n: string) => (n === 'kunde.de' ? [{ exchange: 'mail.kunde.de', priority: 10 }] : []),
      resolveCname: async () => [],
      resolve4: async () => [],
    };
    await t.api.patch('/api/location', { settings: { email: { provider: 'smtp', host: 'smtp.kunde.de', fromEmail: 'info@kunde.de' } } });
    const r = await mcp('ghl_mail_domain_check', {}, keyA);
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({ domain: 'kunde.de', status: 'fail' });
    const dmarc = r.data.checks.find((c: any) => c.check === 'DMARC');
    expect(dmarc.records_to_add[0]).toContain('TXT _dmarc v=DMARC1');
    expect(dmarc.steps.length).toBeGreaterThan(1);
    const bad = await mcp('ghl_mail_domain_check', { domain: 'localhost' }, keyA);
    expect(bad.isError).toBe(true);
  });
});
