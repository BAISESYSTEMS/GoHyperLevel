import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffSummary } from '../server/modules/wfx-tools.js';
import { requiredPermission } from '../server/core/permissions.js';
import { newApp, readRun, results, type T } from './wfx-helpers.js';

/** Catalog, test run, run log, versions with draft and publish, import/export, MCP tools. */

let t: T;
let loc = '';
beforeAll(async () => {
  t = await newApp();
  loc = t.api.location;
});
afterAll(() => t.close());
const set = (name: string, value: string, id?: string) => ({ ...(id ? { id } : {}), type: 'set_variable', rows: [{ name, value }] });
const create = async (steps: any[], extra: Record<string, unknown> = {}) => {
  const r = await t.api.post('/api/workflows', { name: `wf ${Math.random()}`, trigger: { type: 'manual', config: {} }, steps, ...extra });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data as any;
};

describe('catalog', () => {
  it('lists every step and trigger with category, docs and fields; searchable and filterable', async () => {
    const all = (await t.api.get('/api/workflow-catalog')).data;
    expect(all.counts.actions).toBeGreaterThanOrEqual(60);
    expect(all.categories.map((c: any) => c.key)).toEqual(expect.arrayContaining(['flow', 'data', 'crm', 'sales', 'messaging', 'payments', 'content', 'ai', 'integration', 'apps']));
    const code = all.actions.find((a: any) => a.type === 'code');
    expect(code).toMatchObject({ label: 'Code (Ausdruck)', category: 'data', pure: true });
    expect(code.doc).toMatch(/kein eval/);
    expect(code.fields.find((f: any) => f.key === 'code').type).toBe('code');
    expect(all.functions.map((f: any) => f.name)).toEqual(expect.arrayContaining(['map', 'format_date', 'regex_test']));
    // older steps appear too, marked as having their own editor
    expect(all.actions.find((a: any) => a.type === 'send_email')).toMatchObject({ category: 'messaging', custom: true });
    const q = (await t.api.get('/api/workflow-catalog?q=geburtstag&kind=triggers')).data;
    expect(q.actions).toEqual([]);
    expect(q.triggers.map((x: any) => x.type)).toEqual(expect.arrayContaining(['contact.birthday', 'date.reached']));
    const cat = (await t.api.get('/api/workflow-catalog?category=ai&kind=actions&compact=1')).data;
    expect(cat.actions.map((a: any) => a.type)).toEqual(expect.arrayContaining(['ai_classify', 'ai_extract', 'ai_sentiment', 'ai_summarize', 'ai_translate', 'ai_text']));
    expect(cat.actions[0].doc).toBeUndefined();
    expect((await t.api.get('/api/workflow-catalog?q=xyzxyz-nichts')).data.actions).toEqual([]);
  });

  it('describes every action for the generic editor consistently', async () => {
    const all = (await t.api.get('/api/workflow-catalog')).data;
    const cats = new Set(all.categories.map((c: any) => c.key));
    const types = new Set<string>();
    for (const a of all.actions) {
      expect(types.has(a.type), `duplicate ${a.type}`).toBe(false);
      types.add(a.type);
      expect(a.label, a.type).toBeTruthy();
      expect(cats.has(a.category), `${a.type}: ${a.category}`).toBe(true);
      if (!a.custom) {
        expect(a.summary.length, a.type).toBeGreaterThan(10);
        expect(a.doc.length, a.type).toBeGreaterThan(30);
        const keys = new Set<string>();
        for (const f of a.fields) {
          expect(keys.has(f.key), `${a.type}.${f.key} twice`).toBe(false);
          keys.add(f.key);
          expect(f.label, `${a.type}.${f.key}`).toBeTruthy();
          if (f.type === 'select') expect(Array.isArray(f.options), `${a.type}.${f.key} options`).toBe(true);
          if (f.showIf) expect(f.showIf.field, `${a.type}.${f.key} showIf`).toBeTruthy();
        }
        // a sample must only use fields the form has
        for (const k of Object.keys(a.sample ?? {})) expect([...keys, 'id', 'type'].includes(k) || /^b\d$|^each$/.test(k), `${a.type}: sample key ${k}`).toBe(true);
      }
    }
  });

  it('keeps the catalog and its helpers in the workflows area', () => {
    for (const p of ['/api/workflow-catalog', '/api/workflow-export', '/api/workflow-import', '/api/custom-events', '/api/workflows/x/test-run', '/api/workflows/x/versions', '/api/workflows/x/publish', '/api/workflow-runs/x']) expect(requiredPermission('GET', p), p).toBe('workflows');
  });
});

describe('test run', () => {
  it('walks the workflow with sample data: logic runs for real, side effects only show what they would do', async () => {
    const wf = await create([
      { type: 'format_text', op: 'upper', input: '{{contact.first_name}}', save_to: 'var.name' },
      { type: 'send_email', subject: 'Hallo {{var.name}}', body: 'Text' },
      { type: 'add_tag', tags: ['getestet'] },
      { type: 'if', expression: 'var.name == "ERIKA"', then: [set('weg', 'then')], else: [set('weg', 'else')] },
      { type: 'wait', amount: 2, unit: 'days' },
      { type: 'http_request', url: 'https://api.example.com/x', auth: 'bearer', auth_secret: 'geheim' },
      { type: 'update_field', field: 'custom.x', value: 'y' },
      { type: 'split_test', variants: [{ name: 'A', weight: 50 }, { name: 'B', weight: 50 }], b0: [set('p', 'a')], b1: [set('p', 'b')] },
      set('ende', 'ja'),
    ]);
    const r = (await t.api.post(`/api/workflows/${wf.id}/test-run`, {})).data;
    expect(r.status).toBe('completed');
    expect(r.contact).toMatchObject({ sample: true, name: 'Erika Muster' });
    const byType = (type: string) => r.log.filter((l: any) => l.type === type);
    expect(byType('format_text')[0].output).toBe('ERIKA');
    expect(byType('send_email')[0]).toMatchObject({ result: 'Trockenlauf: nicht ausgeführt', dry: true });
    expect(byType('send_email')[0].input.subject).toBe('Hallo ERIKA');
    expect(byType('if')[0].result).toBe('ja');
    expect(byType('wait')[0].result).toMatch(/^Trockenlauf: würde bis/);
    expect(JSON.stringify(byType('http_request')[0].input)).not.toContain('geheim');
    expect(r.vars).toMatchObject({ name: 'ERIKA', weg: 'then', ende: 'ja' });
    expect(['a', 'b']).toContain(r.vars.p);
    expect(r.summary.skipped).toBe(4); // e-mail, tag, http, field
    // nothing really happened
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM workflow_runs WHERE workflow_id = ?', wf.id)!.n).toBe(0);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM messages WHERE subject LIKE ?', 'Hallo ERIKA%')!.n).toBe(0);
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM wfx_split WHERE workflow_id = ?`, wf.id)!.n).toBe(0);
  });

  it('takes sample data, a real contact and an unsaved draft; sets event data from the trigger', async () => {
    const wf = await create([set('x', '{{event.rating}} / {{contact.city}} / {{var.start}}')], { trigger: { type: 'review.received', config: {} } });
    const sample = (await t.api.post(`/api/workflows/${wf.id}/test-run`, { sample: { contact: { city: 'Bonn' }, event: { rating: 2 }, vars: { start: 'v' } } })).data;
    expect(sample.vars.x).toBe('2 / Bonn / v');
    const dflt = (await t.api.post(`/api/workflows/${wf.id}/test-run`, {})).data;
    expect(dflt.vars.x).toBe('5 / Köln /'); // the sample event of the trigger (an empty field at the end leaves no trailing space)
    const real = (await t.api.post('/api/contacts', { first_name: 'Real', email: 'real-test@example.com', city: 'Essen' })).data;
    const withReal = (await t.api.post(`/api/workflows/${wf.id}/test-run`, { contact_id: real.id, sample: { event: { rating: 1 } } })).data;
    expect(withReal.contact).toMatchObject({ id: real.id, sample: false });
    expect(withReal.vars.x).toBe('1 / Essen /');
    const draft = (await t.api.post(`/api/workflows/${wf.id}/test-run`, { workflow: { steps: [set('y', 'aus dem Entwurf')] } })).data;
    expect(draft.vars).toEqual({ y: 'aus dem Entwurf' });
    expect((await t.api.post(`/api/workflows/${wf.id}/test-run`, { contact_id: 'nope' })).status).toBe(404);
    expect((await t.api.post(`/api/workflows/${wf.id}/test-run`, { workflow: { steps: [{ type: 'gibt-es-nicht' }] } })).status).toBe(400);
    expect((await t.api.post('/api/workflows/nope/test-run', {})).status).toBe(404);
  });

  it('stops runaway workflows in a test run and shows errors per step', async () => {
    const wf = await create([{ id: 'a', type: 'goto', target: 'a', max_jumps: 100 }, set('x', '1')], { settings: { max_steps: 30 } });
    const r = (await t.api.post(`/api/workflows/${wf.id}/test-run`, {})).data;
    expect(r.status).toBe('failed');
    expect(r.log.at(-1).error).toMatch(/Grenze von 30 Schritten/);
    const bad = await create([{ type: 'math', operation: 'divide', a: '1', b: '0' }, set('weiter', 'ja')]);
    const r2 = (await t.api.post(`/api/workflows/${bad.id}/test-run`, {})).data;
    expect(r2.summary.errors).toBe(1);
    expect(r2.vars.weiter).toBe('ja');
  });
});

describe('run log with inputs and outputs', () => {
  it('stores the rendered inputs, outputs and set values of every step and serves them per run', async () => {
    const wf = await create([{ type: 'math', operation: 'multiply', a: '{{contact.custom.menge}}', b: '2', save_to: 'var.m' }, { type: 'http_request', url: 'https://x.example.com/', auth_secret: 'geheim', headers: [{ name: 'Authorization', value: 'Bearer abc' }] }]);
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const c = (await t.api.post('/api/contacts', { first_name: 'Log', email: 'log@example.com', custom: { menge: '21' } })).data;
    await t.api.post(`/api/workflows/${wf.id}/enroll`, { contact_ids: [c.id] });
    const list = (await t.api.get(`/api/workflows/${wf.id}/runs`)).data.runs[0];
    expect(list.log[0].input).toBeUndefined(); // the list stays light
    const run = (await t.api.get(`/api/workflow-runs/${list.id}`)).data;
    expect(run.workflow_name).toBe(wf.name);
    expect(run.log[0]).toMatchObject({ type: 'math', result: 'Variable m = 42', output: 42 });
    expect(run.log[0].input).toMatchObject({ operation: 'multiply', a: '21', b: '2' });
    expect(run.log[0].set).toEqual({ vars: { m: 42 } });
    expect(typeof run.log[0].ms).toBe('number');
    expect(JSON.stringify(run.log[1].input)).not.toContain('geheim');
    expect(JSON.stringify(run.log[1].input)).not.toContain('Bearer abc');
    expect(run.vars).toEqual({ m: 42 });
    expect((await t.api.get('/api/workflow-runs/nope')).status).toBe(404);
  });
});

describe('versions, draft and publish', () => {
  it('records a version for every saved change and describes it', async () => {
    const wf = await create([set('a', '1', 's1')]);
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' }); // no content change: no version
    const two = [set('a', '1', 's1'), { id: 's2', type: 'add_tag', tags: ['x'] }];
    await t.api.patch(`/api/workflows/${wf.id}`, { steps: two });
    await t.api.patch(`/api/workflows/${wf.id}`, { steps: two }); // same content
    const second = (await t.api.get(`/api/workflows/${wf.id}`)).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { trigger: { type: 'contact.created', config: {} }, steps: second.steps.slice(0, 1) });
    const v = (await t.api.get(`/api/workflows/${wf.id}/versions`)).data;
    expect(v.versions.map((x: any) => x.version)).toEqual([3, 2, 1]);
    expect(v.versions[2].summary).toMatch(/^Erste Version · 1 Schritte/);
    expect(v.versions[1].summary).toBe('1 Schritt neu');
    expect(v.versions[0].summary).toMatch(/Auslöser geändert/);
    expect(v.versions[0].summary).toMatch(/1 entfernt/);
    const one = (await t.api.get(`/api/workflows/${wf.id}/versions/2`)).data;
    expect(one.workflow.steps).toHaveLength(2);
    expect((await t.api.get(`/api/workflows/${wf.id}/versions/99`)).status).toBe(404);
  });

  it('keeps edits in a draft until they are published, with a note', async () => {
    const wf = await create([set('a', '1', 's1')]);
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    expect((await t.api.get(`/api/workflows/${wf.id}/draft`)).data.draft).toBeNull();
    expect((await t.api.post(`/api/workflows/${wf.id}/publish`, {})).status).toBe(400);
    const saved = await t.api.put(`/api/workflows/${wf.id}/draft`, { steps: [set('a', '2', 's1'), set('b', '3', 's2')], name: 'Neuer Name' });
    expect(saved.data.ok).toBe(true);
    // live is untouched while the draft exists
    const live = (await t.api.get(`/api/workflows/${wf.id}`)).data;
    expect(live.steps).toHaveLength(1);
    expect(live.name).toBe(wf.name);
    const list = (await t.api.get(`/api/workflows/${wf.id}/versions`)).data;
    expect(list.draft).toBeTruthy();
    expect((await t.api.put(`/api/workflows/${wf.id}/draft`, { steps: [{ type: 'nope' }] })).status).toBe(400);
    const pub = (await t.api.post(`/api/workflows/${wf.id}/publish`, { note: 'Zweiter Schritt' })).data;
    expect(pub).toMatchObject({ name: 'Neuer Name', version: 2, status: 'active' });
    expect(pub.steps).toHaveLength(2);
    expect((await t.api.get(`/api/workflows/${wf.id}/draft`)).data.draft).toBeNull();
    const v = (await t.api.get(`/api/workflows/${wf.id}/versions`)).data.versions;
    expect(v[0]).toMatchObject({ version: 2, note: 'Zweiter Schritt', summary: expect.stringContaining('1 Schritt neu') });
    // restoring an old version only fills the draft
    const r = await t.api.post(`/api/workflows/${wf.id}/versions/1/restore`, {});
    expect(r.data.message).toContain('Version 1');
    expect((await t.api.get(`/api/workflows/${wf.id}`)).data.steps).toHaveLength(2);
    const d = (await t.api.get(`/api/workflows/${wf.id}/draft`)).data.draft;
    expect(d.steps).toHaveLength(1);
    expect((await t.api.del(`/api/workflows/${wf.id}/draft`)).data.ok).toBe(true);
    expect((await t.api.get(`/api/workflows/${wf.id}/draft`)).data.draft).toBeNull();
  });

  it('summarises differences between versions', () => {
    const step = (id: string, value = '1') => ({ id, type: 'set_variable', rows: [{ name: 'a', value }] });
    expect(diffSummary(undefined, { trigger: {}, steps: [step('a')] })).toBe('Erste Version · 1 Schritte');
    expect(diffSummary({ trigger: { type: 'x' }, steps: [step('a')] }, { trigger: { type: 'x' }, steps: [step('a')] })).toBe('Keine inhaltliche Änderung');
    expect(diffSummary({ trigger: {}, steps: [step('a')] }, { trigger: {}, steps: [step('a', '2'), step('b')] })).toBe('1 Schritt neu · 1 geändert');
    expect(diffSummary({ trigger: {}, steps: [step('a')], settings: {} }, { trigger: {}, steps: [step('a')], settings: { stop_on_error: true } })).toBe('Einstellungen geändert');
  });
});

describe('import and export', () => {
  it('exports portable JSON without header secrets and imports it as an inactive draft with new ids', async () => {
    const wf = await create([
      { id: 'start', type: 'http_request', url: 'https://x.example.com/', auth: 'bearer', auth_secret: 'geheim', headers: [{ name: 'X-Api-Key', value: 'k-123' }, { name: 'X-Ok', value: '1' }] },
      { id: 'loop1', type: 'split_test', variants: [{ name: 'A', weight: 50 }, { name: 'B', weight: 50 }], b0: [{ id: 'inner', type: 'goto', target: 'start', max_jumps: 2 }], b1: [] },
      { type: 'wait_until', expression: 'true', timeout_amount: 1, timeout_unit: 'days', on_timeout: 'goto', timeout_target: 'inner' },
      { type: 'update_opportunity', pipeline_id: 'pipe-ghost' },
    ]);
    const exp = (await t.api.get(`/api/workflows/${wf.id}/export`)).data;
    expect(exp).toMatchObject({ format: 'gohigh-workflow', version: 1, workflow: { name: wf.name } });
    expect(JSON.stringify(exp)).not.toContain('geheim');
    expect(JSON.stringify(exp)).not.toContain('k-123');
    expect(exp.workflow.steps[0].headers).toEqual([{ name: 'X-Api-Key', value: '' }, { name: 'X-Ok', value: '1' }]);
    expect(exp.references).toContain('pipeline_id:pipe-ghost');
    // the stored workflow keeps its secret
    expect((await t.api.get(`/api/workflows/${wf.id}`)).data.steps[0].auth_secret).toBe('geheim');

    const imp = (await t.api.post('/api/workflow-import', { data: exp, name: 'Kopie' })).data;
    expect(imp.imported).toHaveLength(1);
    expect(imp.imported[0].name).toBe('Kopie');
    expect(imp.imported[0].warnings.join(' ')).toContain('Pipeline „pipe-ghost“ gibt es in diesem Sub-Account nicht');
    const copy = (await t.api.get(`/api/workflows/${imp.imported[0].id}`)).data;
    expect(copy.status).toBe('draft');
    const ids = copy.steps.map((s: any) => s.id);
    expect(ids).not.toContain('start');
    expect(copy.steps[1].b0[0].id).not.toBe('inner');
    expect(copy.steps[1].b0[0].target).toBe(copy.steps[0].id); // the go-to follows the new id
    expect(copy.steps[2].timeout_target).toBe(copy.steps[1].b0[0].id);
    expect(copy.steps[1].variants).toHaveLength(2);
    // importing the same file twice makes two independent workflows
    const again = (await t.api.post('/api/workflow-import', { data: exp })).data;
    expect(again.imported[0].id).not.toBe(imp.imported[0].id);
  });

  it('exports and imports all workflows as a bundle and refuses bad input', async () => {
    const bundle = (await t.api.get('/api/workflow-export')).data;
    expect(bundle.format).toBe('gohigh-workflows');
    expect(bundle.workflows.length).toBeGreaterThan(3);
    const some = { ...bundle, workflows: bundle.workflows.slice(0, 2) };
    const r = (await t.api.post('/api/workflow-import', { data: some })).data;
    expect(r.imported).toHaveLength(2);
    expect((await t.api.post('/api/workflow-import', { data: 'kein json{' })).status).toBe(400);
    expect((await t.api.post('/api/workflow-import', { data: { format: 'etwas-anderes', workflow: { steps: [] } } })).data.error).toMatch(/Unbekanntes Format/);
    expect((await t.api.post('/api/workflow-import', { data: { workflow: { name: 'x' } } })).status).toBe(400);
    expect((await t.api.post('/api/workflow-import', { data: { workflow: { name: 'x', trigger: { type: 'gibt-es-nicht' }, steps: [] } } })).data.error).toMatch(/Unbekannter Auslöser/);
    expect((await t.api.post('/api/workflow-import', { data: { workflow: { name: 'x', steps: [{ type: 'unbekannt' }] } } })).data.error).toMatch(/Unbekannter Schritt/);
    expect((await t.api.post('/api/workflow-import', { data: { format: 'gohigh-workflows', workflows: [] } })).data.error).toMatch(/keine Workflows/);
    expect((await t.api.get('/api/workflows/nope/export')).status).toBe(404);
  });

  it('does not import into or read from another sub-account', async () => {
    const other = (await t.api.post('/api/locations', { name: 'Andere Firma' })).data;
    const wf = await create([set('a', '1')]);
    t.api.setLocation(other.id);
    expect((await t.api.get(`/api/workflows/${wf.id}/export`)).status).toBe(404);
    expect((await t.api.get(`/api/workflows/${wf.id}/versions`)).status).toBe(404);
    expect((await t.api.post(`/api/workflows/${wf.id}/test-run`, {})).status).toBe(404);
    expect((await t.api.get(`/api/workflows/${wf.id}/split-stats`)).status).toBe(404);
    expect((await t.api.put(`/api/workflows/${wf.id}/draft`, { steps: [] })).status).toBe(404);
    expect((await t.api.post(`/api/workflows/${wf.id}/publish`, {})).status).toBe(404);
    t.api.setLocation(loc);
  });
});

describe('MCP tools', () => {
  it('registers the workflow tools with the shared REST routes behind them', async () => {
    const names = (t.app.services.mcpTools as any[]).map((x) => x.name);
    for (const n of ['ghl_workflow_catalog', 'ghl_workflow_test_run', 'ghl_workflow_export', 'ghl_workflow_import', 'ghl_emit_event']) expect(names, n).toContain(n);
    const calls: any[] = [];
    const call = { agency: true, api: async (method: string, path: string, o?: any) => (calls.push({ method, path, o }), {}) } as any;
    const tool = (n: string) => (t.app.services.mcpTools as any[]).find((x) => x.name === n);
    await tool('ghl_workflow_catalog').run(call, { location_id: loc, q: 'loop', category: 'flow' });
    await tool('ghl_workflow_test_run').run(call, { location_id: loc, workflow_id: 'w1', sample: { event: { a: 1 } } });
    await tool('ghl_workflow_export').run(call, { location_id: loc, all: true });
    await tool('ghl_workflow_export').run(call, { location_id: loc, workflow_id: 'w1' });
    await tool('ghl_emit_event').run(call, { location_id: loc, name: 'x', email: 'a@b.de', create: true });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/workflow-catalog?q=loop&category=flow&compact=1', 'POST /api/workflows/w1/test-run', 'GET /api/workflow-export', 'GET /api/workflows/w1/export', 'POST /api/custom-events']);
    // the whole round trip over the real MCP endpoint is covered in the MCP tests; here we only check the shape
    expect(tool('ghl_workflow_import').inputSchema.required).toEqual(['location_id', 'data']);
  });
});
void readRun;
void results;
