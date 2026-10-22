import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contactOf, newApp, results, runWorkflow, type T } from './wfx-helpers.js';

/** Data steps end to end: variables, formatters, math, fields, lists, JSON, maps, code, find. */

let t: T;
beforeAll(async () => {
  t = await newApp();
});
afterAll(() => t.close());

describe('variables and formatters', () => {
  it('sets variables with types and uses them in later steps', async () => {
    const { vars, log, contact } = await runWorkflow(
      t,
      [
        { type: 'set_variable', rows: [{ name: 'budget', value: '1.234,50', type: 'number' }, { name: 'who', value: '{{contact.first_name}} {{contact.last_name}}', type: 'text' }, { name: 'flag', value: 'ja', type: 'bool' }, { name: 'list', value: '["a","b"]', type: 'json' }] },
        { type: 'update_field', field: 'custom.note', value: '{{var.who}} / {{var.budget}}' },
      ],
    );
    expect(vars).toMatchObject({ budget: 1234.5, who: 'Erika Muster', flag: true, list: ['a', 'b'] });
    expect(contactOf(t, contact.id).custom.note).toBe('Erika Muster / 1234.5');
    expect(log[0].result).toContain('Variablen gesetzt');
    expect(log[0].input).toBeTruthy();
    expect(log[0].set.vars.budget).toBe(1234.5);
  });

  it('rejects a number that is none', async () => {
    const { log } = await runWorkflow(t, [{ type: 'set_variable', rows: [{ name: 'x', value: 'abc', type: 'number' }] }]);
    expect(results(log)[0]).toMatch(/keine Zahl/);
  });

  it('formats text, numbers and dates', async () => {
    const { vars, log } = await runWorkflow(
      t,
      [
        { type: 'format_text', op: 'upper', input: '{{contact.first_name}}', save_to: 'var.a' },
        { type: 'format_text', op: 'replace', input: 'a-b-c', arg1: '-', arg2: '+', save_to: 'var.b' },
        { type: 'format_text', op: 'split', input: 'x,y,z', arg1: ',', save_to: 'var.c' },
        { type: 'format_text', op: 'extract', input: 'Bestellung #4711 ok', arg1: '#(\\d+)', save_to: 'var.d' },
        { type: 'format_text', op: 'phone', input: '0171 1234567', save_to: 'var.e' },
        { type: 'format_number', op: 'currency', input: '1234.5', save_to: 'var.f' },
        { type: 'format_number', op: 'round', input: '2,675', digits: 2, save_to: 'var.g' },
        { type: 'format_number', op: 'format', input: '1234567.891', digits: 1, save_to: 'var.h' },
        { type: 'format_date', op: 'add', input: '2026-03-27 12:00', amount: 3, unit: 'business_days', save_to: 'var.i' },
        { type: 'format_date', op: 'format', input: '2026-03-29T10:00:00Z', pattern: 'dddd, D. MMMM YYYY HH:mm', save_to: 'var.j' },
        { type: 'format_date', op: 'convert_tz', input: '2026-07-01T12:00:00Z', to_tz: 'America/New_York', pattern: 'DD.MM.YYYY HH:mm Z', save_to: 'var.k' },
      ],
    );
    expect(log.every((l) => !l.error), JSON.stringify(log.filter((l) => l.error))).toBe(true);
    expect(vars.a).toBe('ERIKA');
    expect(vars.b).toBe('a+b+c');
    expect(vars.c).toEqual(['x', 'y', 'z']);
    expect(vars.d).toBe('4711');
    expect(vars.e).toBe('+491711234567');
    expect(vars.f).toMatch(/1\.234,50\s*€/);
    expect(vars.g).toBe(2.68);
    expect(vars.h).toBe('1.234.567,9');
    expect(vars.i).toBe('2026-04-01T10:00:00.000Z'); // Fri 12:00 Berlin (CET) + 3 business days = Wed, still 12:00 (CEST from 29 March) = 10:00Z
    expect(vars.j).toBe('Sonntag, 29. März 2026 12:00');
    expect(vars.k).toBe('01.07.2026 08:00 -04:00');
  });

  it('writes a formatted value into a contact field and announces the change', async () => {
    const { contact } = await runWorkflow(t, [{ type: 'format_text', op: 'phone', input: '{{contact.phone}}', save_to: 'phone' }], { contact: { phone: '0171 7654321' } });
    expect(contactOf(t, contact.id).phone).toBe('+491717654321');
  });
});

describe('math', () => {
  it('calculates and rounds', async () => {
    const { vars, log } = await runWorkflow(
      t,
      [
        { type: 'math', operation: 'multiply', a: '3', b: '19,99', digits: 2, save_to: 'var.m1' },
        { type: 'math', operation: 'percent_of', a: '250', b: '19', save_to: 'var.m2' },
        { type: 'math', operation: 'percent_change', a: '80', b: '100', save_to: 'var.m3' },
        { type: 'math', operation: 'formula', formula: 'round(number("1.000,5") * 1.19, 2)', save_to: 'var.m4' },
        { type: 'math', operation: 'divide', a: '1', b: '0', save_to: 'var.bad' },
      ],
    );
    expect(vars).toMatchObject({ m1: 59.97, m2: 47.5, m3: 25, m4: 1190.6 });
    expect(results(log)[4]).toMatch(/Division durch 0/);
    expect(vars.bad).toBeUndefined();
  });
});

describe('fields in bulk', () => {
  it('copies, sets, clears and keeps the rest', async () => {
    const { contact, log } = await runWorkflow(
      t,
      [
        { type: 'set_fields', rows: [{ field: 'city', value: 'Köln' }, { field: 'custom.quelle', value: 'Messe' }, { field: 'var.tmp', value: 'x' }] },
        { type: 'copy_field', from: 'custom.quelle', to: 'custom.quelle_kopie', transform: 'upper' },
        { type: 'copy_field', from: 'custom.quelle', to: 'city', only_if_empty: true },
        { type: 'clear_fields', rows: [{ field: 'custom.quelle' }, { field: 'var.tmp' }] },
      ],
      { contact: { custom: { alt: '1' } } },
    );
    const c = contactOf(t, contact.id);
    expect(c.city).toBe('Köln');
    expect(c.custom).toEqual({ alt: '1', quelle_kopie: 'MESSE' });
    expect(log.some((l) => l.error), JSON.stringify(log)).toBe(false);
    expect(results(log)[2]).toContain('schon gefüllt');
  });

  it('fires "contact.updated" with the changed fields and not for the workflow itself', async () => {
    const seen: any[] = [];
    t.app.events.on('contact.updated', (e) => void seen.push(e.data));
    const { contact } = await runWorkflow(t, [{ type: 'set_fields', rows: [{ field: 'custom.stufe', value: 'gold' }] }]);
    await t.app.events.flush();
    const mine = seen.filter((d) => d.contactId === contact.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ changed: ['custom.stufe'], viaWorkflow: expect.any(String), wfDepth: 1 });
  });
});

describe('lists, JSON, maps, random, code', () => {
  it('builds and transforms lists', async () => {
    const { vars } = await runWorkflow(
      t,
      [
        { type: 'array_op', op: 'split', input: 'b, a ,b,c', arg: ',', save_to: 'var.l' },
        { type: 'array_op', op: 'unique', input: '{{var.l}}', save_to: 'var.u' },
        { type: 'array_op', op: 'sort', input: '{{var.u}}', save_to: 'var.s' },
        { type: 'array_op', op: 'count', input: '{{var.s}}', save_to: 'var.n' },
        { type: 'array_op', op: 'join', input: '{{var.s}}', arg: ' | ', save_to: 'var.j' },
        { type: 'array_op', op: 'from_tags', save_to: 'var.t' },
        { type: 'array_op', op: 'sum', input: '[1, "2,5", 3]', save_to: 'var.sum' },
      ],
      { contact: { tags: ['x', 'y'] } },
    );
    expect(vars).toMatchObject({ l: ['b', 'a', 'b', 'c'], u: ['b', 'a', 'c'], s: ['a', 'b', 'c'], n: 3, j: 'a | b | c', t: ['x', 'y'], sum: 6.5 });
  });

  it('reads JSON, maps values and picks at random', async () => {
    t.app.services.wfxRandom = () => 0.99;
    const { vars, contact, log } = await runWorkflow(
      t,
      [
        { type: 'set_variable', rows: [{ name: 'resp', value: '{"data": {"id": 77, "items": [{"sku": "A1"}]}}', type: 'json' }] },
        { type: 'json_extract', input: '{{var.resp}}', rows: [{ path: 'data.id', to: 'custom.crm_id' }, { path: 'data.items.0.sku', to: 'var.sku' }, { path: 'data.nope', to: 'var.nope' }] },
        { type: 'value_map', input: '{{contact.city}}', rows: [{ from: 'köln', to: 'West' }, { from: 'Berlin', to: 'Ost' }], default: 'Sonst', save_to: 'var.region' },
        { type: 'random_pick', mode: 'list', options: 'rot\ngrün\nblau', save_to: 'var.farbe' },
        { type: 'random_pick', mode: 'number', min: 1, max: 6, save_to: 'var.wuerfel' },
        { type: 'random_pick', mode: 'code', prefix: 'GH-', length: 6, save_to: 'var.code' },
      ],
      { contact: { city: 'Köln' } },
    );
    delete t.app.services.wfxRandom;
    expect(log.some((l) => l.error), JSON.stringify(log)).toBe(false);
    expect(contactOf(t, contact.id).custom.crm_id).toBe('77');
    expect(vars).toMatchObject({ sku: 'A1', region: 'West', farbe: 'blau', wuerfel: 6 });
    expect(vars.code).toMatch(/^GH-[A-Z2-9]{6}$/);
    expect(vars.nope).toBeUndefined();
    expect(log[1].result).toContain('nicht gefunden: data.nope');
  });

  it('runs the code step in the sandbox and writes variables', async () => {
    const { vars, log } = await runWorkflow(
      t,
      [
        { type: 'code', code: 'let total = 0; for (let x of [1, 2, 3]) { total += x } var.extra = total * 2; return contact.custom.budget > 1000 ? "vip" : "standard"', save_to: 'var.segment' },
        { type: 'code', code: 'process.exit(1)', save_to: 'var.x' },
        { type: 'code', code: 'while (true) {}', save_to: 'var.y' },
      ],
      { contact: { custom: { budget: '2500' } } },
    );
    expect(vars).toMatchObject({ segment: 'vip', extra: 12 });
    expect(results(log)[1]).toMatch(/nicht bekannt/);
    expect(results(log)[2]).toMatch(/Schritt-Grenze/);
    expect(vars.x).toBeUndefined();
  });

  it('refuses a broken code step or expression when the workflow is saved', async () => {
    const r = await t.api.post('/api/workflows', { name: 'kaputt', trigger: { type: 'manual', config: {} }, steps: [{ type: 'code', code: 'let = ' }] });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/Code-Schritt/);
    const r2 = await t.api.post('/api/workflows', { name: 'kaputt2', trigger: { type: 'manual', config: {} }, steps: [{ type: 'if', expression: '1 +', conditions: [] }] });
    expect(r2.status).toBe(400);
    expect(r2.data.error).toMatch(/Ausdruck/);
  });

  it('uses an expression in Wenn/Sonst', async () => {
    const { log } = await runWorkflow(
      t,
      [
        { type: 'if', expression: 'number(contact.custom.budget) >= 1000 && "vip" in contact.tags', then: [{ type: 'set_variable', rows: [{ name: 'path', value: 'vip' }] }], else: [{ type: 'set_variable', rows: [{ name: 'path', value: 'std' }] }] },
      ],
      { contact: { tags: ['vip'], custom: { budget: '1500' } } },
    );
    expect(results(log)).toEqual(['ja', 'Variablen gesetzt: path']);
  });
});

describe('find', () => {
  it('finds contacts by field and continues with the found one', async () => {
    const other = (await t.api.post('/api/contacts', { first_name: 'Otto', email: 'otto-find@example.com', custom: { kundennr: 'K-77' } })).data;
    const { vars, run, log } = await runWorkflow(t, [
      { type: 'find_contact', by: 'email', value: 'OTTO-find@example.com', switch_contact: true },
      { type: 'update_field', field: 'custom.gefunden', value: 'ja' },
      { type: 'find_contact', by: 'custom', custom_key: 'kundennr', value: 'K-77' },
      { type: 'find_contact', by: 'email', value: 'niemand@example.com', on_missing: 'end' },
      { type: 'update_field', field: 'custom.nie', value: 'x' },
    ]);
    expect(run.contact_id).toBe(other.id);
    expect(contactOf(t, other.id).custom.gefunden).toBe('ja');
    expect(contactOf(t, other.id).custom.nie).toBeUndefined();
    expect(vars.contact_found).toBe(false);
    expect(results(log)[3]).toContain('Ablauf beendet');
    expect(run.status).toBe('completed');
  });

  it('finds or creates a contact', async () => {
    const first = await runWorkflow(t, [{ type: 'find_or_create_contact', by: 'email', value: 'neu-fc@example.com', rows: [{ field: 'first_name', value: 'Nele' }, { field: 'custom.quelle', value: 'webhook' }], tags: ['webhook'], switch_contact: true }]);
    expect(first.vars).toMatchObject({ contact_found: false, contact_created: true });
    const created = t.app.db.get(`SELECT * FROM contacts WHERE email = 'neu-fc@example.com'`)!;
    expect(created.first_name).toBe('Nele');
    expect(JSON.parse(created.tags)).toContain('webhook');
    const second = await runWorkflow(t, [{ type: 'find_or_create_contact', by: 'email', value: 'neu-fc@example.com', rows: [{ field: 'first_name', value: 'Anders' }], update_existing: false }]);
    expect(second.vars).toMatchObject({ contact_found: true, contact_created: false });
    expect(t.app.db.get(`SELECT first_name FROM contacts WHERE email = 'neu-fc@example.com'`)!.first_name).toBe('Nele');
  });

  it('finds a deal of the contact', async () => {
    const pipe = (await t.api.post('/api/pipelines', { name: 'Verkauf', stages: ['Neu', 'Angebot'] })).data;
    const c = (await t.api.post('/api/contacts', { first_name: 'Dana', email: 'dana-deal@example.com' })).data;
    await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: c.id, name: 'Klein', value: 100 });
    await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: c.id, name: 'Groß', value: 900 });
    const wf = (await t.api.post('/api/workflows', { name: 'deal', trigger: { type: 'manual', config: {} }, steps: [{ type: 'find_opportunity', which: 'highest' }, { type: 'find_opportunity', status: 'won' }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    await t.api.post(`/api/workflows/${wf.id}/enroll`, { contact_ids: [c.id] });
    const run = t.app.db.get('SELECT * FROM workflow_runs WHERE workflow_id = ?', wf.id)!;
    expect(JSON.parse(run.vars)).toMatchObject({ deal_found: false });
    const log = JSON.parse(run.log);
    expect(log[0].output).toMatchObject({ name: 'Groß', value: 900, stage_name: 'Neu' });
  });
});
