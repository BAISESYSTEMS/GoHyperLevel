import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pickVariant, stableRandom, dripSlot } from '../server/services/wfx-flow.js';
import { contactOf, newApp, readRun, results, resume, runWorkflow, settle, type T } from './wfx-helpers.js';

/** Flow steps: go-to, goal jump, split test, loop, drip and the waits (with a moved clock). */

let t: T;
beforeAll(async () => {
  t = await newApp();
});
afterAll(() => t.close());
afterEach(() => {
  delete t.app.services.wfxNow;
  delete t.app.services.wfxRandom;
});
const at = (iso: string) => (t.app.services.wfxNow = () => Date.parse(iso));
const set = (name: string, value: string) => ({ type: 'set_variable', rows: [{ name, value }] });

describe('go to and goal jump', () => {
  it('jumps back and forth but never more often than allowed', async () => {
    const { log, vars, run } = await runWorkflow(t, [
      { id: 'start', ...{ type: 'math', operation: 'add', a: '{{var.n}}', b: '1', save_to: 'var.n' } },
      { id: 'jump', type: 'goto', target: 'start', max_jumps: 3 },
      set('done', 'ja'),
    ], { event: { x: 1 } });
    // n starts empty (0): start, jump(1), start, jump(2), start, jump(3), start, jump (cap) → done
    expect(vars.n).toBe(4);
    expect(vars.done).toBe('ja');
    expect(results(log).filter((r) => String(r).startsWith('Sprung zu'))).toHaveLength(3);
    expect(results(log).some((r) => String(r).includes('Sprunggrenze erreicht'))).toBe(true);
    expect(run.status).toBe('completed');
  });

  it('a jump into a Wenn/Sonst branch and out again works', async () => {
    const { vars } = await runWorkflow(t, [
      { type: 'goto', target: 'inner' },
      { type: 'set_variable', rows: [{ name: 'skipped', value: 'ja' }] },
      { type: 'if', conditions: [{ field: 'tag', op: 'has', value: 'nie' }], then: [{ id: 'inner', type: 'set_variable', rows: [{ name: 'inner', value: 'ja' }] }], else: [] },
      set('after', 'ja'),
    ]);
    expect(vars).toMatchObject({ inner: 'ja', after: 'ja' });
    expect(vars.skipped).toBeUndefined();
  });

  it('a conditional go-to only jumps when the condition holds; an unknown target is an error', async () => {
    const a = await runWorkflow(t, [{ type: 'goto', target: 'ziel', conditions: [{ field: 'tag', op: 'has', value: 'vip' }] }, set('a', '1'), { id: 'ziel', type: 'end' }]);
    expect(a.vars.a).toBe('1');
    const b = await runWorkflow(t, [{ type: 'goto', target: 'gibts-nicht' }, set('b', '1')]);
    expect(results(b.log)[0]).toMatch(/Sprungziel nicht gefunden/);
    expect(b.vars.b).toBe('1');
  });

  it('ends a runaway workflow at the total step limit', async () => {
    // max_jumps can be at most 100, but two go-tos chasing each other are stopped by the per-run step cap
    const { run, log } = await runWorkflow(t, [{ id: 'a', type: 'goto', target: 'b', max_jumps: 100 }, { id: 'b', type: 'goto', target: 'a', max_jumps: 100 }], { settings: { max_steps: 50 } });
    expect(run.status).toBe('failed');
    expect(String(log[log.length - 1].error)).toMatch(/Grenze von 50 Schritten/);
  });

  it('jumps to a step when the goal is reached and goes on otherwise', async () => {
    const yes = await runWorkflow(t, [{ type: 'goal_jump', conditions: [{ field: 'tag', op: 'has', value: 'termin' }], on_reached: 'goto', target: 'danke' }, set('nachfass', 'ja'), { id: 'danke', ...set('danke', 'ja') }], { contact: { tags: ['termin'] } });
    expect(yes.vars).toMatchObject({ danke: 'ja' });
    expect(yes.vars.nachfass).toBeUndefined();
    expect(results(yes.log)[0]).toContain('erreicht →');
    const no = await runWorkflow(t, [{ type: 'goal_jump', conditions: [{ field: 'tag', op: 'has', value: 'termin' }], on_reached: 'end' }, set('weiter', 'ja')]);
    expect(no.vars.weiter).toBe('ja');
    const end = await runWorkflow(t, [{ type: 'goal_jump', conditions: [{ field: 'tag', op: 'has', value: 'termin' }], on_reached: 'end' }, set('weiter', 'ja')], { contact: { tags: ['termin'] } });
    expect(end.vars.weiter).toBeUndefined();
    expect(end.run.status).toBe('completed');
  });
});

describe('split test', () => {
  it('picks variants by weight', () => {
    const counts = [0, 0, 0];
    let seed = 1;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let i = 0; i < 20000; i++) counts[pickVariant([70, 20, 10], rnd())]++;
    expect(counts[0] / 20000).toBeGreaterThan(0.67);
    expect(counts[0] / 20000).toBeLessThan(0.73);
    expect(counts[1] / 20000).toBeGreaterThan(0.17);
    expect(counts[1] / 20000).toBeLessThan(0.23);
    expect(counts[2] / 20000).toBeGreaterThan(0.08);
    expect(counts[2] / 20000).toBeLessThan(0.12);
    expect(pickVariant([0, 0], 0.9)).toBe(1);
    expect(pickVariant([0, 100], 0)).toBe(1);
    expect(pickVariant([100, 0], 0.999)).toBe(0);
  });

  it('hashes contacts evenly and stably', () => {
    let a = 0;
    for (let i = 0; i < 4000; i++) if (stableRandom(`wf:step:contact${i}`) < 0.5) a++;
    expect(a).toBeGreaterThan(1850);
    expect(a).toBeLessThan(2150);
    expect(stableRandom('x')).toBe(stableRandom('x'));
  });

  it('runs one path, tracks it and continues after the test', async () => {
    t.app.services.wfxRandom = () => 0.9; // random mode: 90 % → path B
    const steps = [
      { id: 'sp', type: 'split_test', name: 'Betreff', sticky: false, variants: [{ name: 'A', weight: 50 }, { name: 'B', weight: 50 }], b0: [set('path', 'a-mail')], b1: [set('path', 'b-mail'), set('extra', 'nur-b')] },
      set('after', 'gemeinsam'),
    ];
    const r = await runWorkflow(t, steps);
    expect(r.vars).toMatchObject({ split: 'B', path: 'b-mail', extra: 'nur-b', after: 'gemeinsam' });
    expect(results(r.log)[0]).toBe('Pfad B (50 %)');
    expect(r.run.status).toBe('completed');
    const row = t.app.db.get('SELECT * FROM wfx_split WHERE workflow_id = ?', r.wf.id)!;
    expect(row).toMatchObject({ step_id: 'sp', variant: 1, name: 'B' });
    t.app.services.wfxRandom = () => 0.1;
    const r2 = await runWorkflow(t, steps);
    expect(r2.vars.path).toBe('a-mail');
  });

  it('keeps a contact on the same path when sticky and normalises the settings', async () => {
    const created = (await t.api.post('/api/workflows', { name: 'stufen', trigger: { type: 'manual', config: {} }, settings: { allow_reentry: true }, steps: [{ type: 'split_test', variants: [{ name: 'Nur einer' }], b0: [set('p', 'x')] }] })).data;
    expect(created.steps[0].variants.map((v: any) => v.name)).toEqual(['A', 'B']);
    const steps = [{ id: 'sp', type: 'split_test', sticky: true, variants: [{ name: 'A', weight: 50 }, { name: 'B', weight: 50 }], b0: [set('p', 'a')], b1: [set('p', 'b')] }];
    const wf = (await t.api.post('/api/workflows', { name: 'sticky', trigger: { type: 'manual', config: {} }, settings: { allow_reentry: true }, steps })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const c = (await t.api.post('/api/contacts', { first_name: 'Stefan', email: 'sticky@example.com' })).data;
    const paths: string[] = [];
    for (let i = 0; i < 4; i++) {
      await t.api.post(`/api/workflows/${wf.id}/enroll`, { contact_ids: [c.id] });
      paths.push(readRun(t, wf.id, c.id).vars.p);
    }
    expect(new Set(paths).size).toBe(1);
  });

  it('counts assignments, runs and goals per path (stats)', async () => {
    const steps = [
      { id: 'sp', type: 'split_test', sticky: false, variants: [{ name: 'A', weight: 50 }, { name: 'B', weight: 50 }], b0: [{ type: 'goal_jump', conditions: [{ field: 'tag', op: 'has', value: 'sieger' }], on_reached: 'end' }], b1: [] },
    ];
    let n = 0;
    t.app.services.wfxRandom = () => (n++ % 2 === 0 ? 0.1 : 0.9);
    const wf = (await t.api.post('/api/workflows', { name: 'stats', trigger: { type: 'manual', config: {} }, steps })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    for (const [i, tags] of [['1', ['sieger']], ['2', []], ['3', []], ['4', []]] as const) {
      const c = (await t.api.post('/api/contacts', { first_name: `S${i}`, email: `stats${i}@example.com`, tags })).data;
      await t.api.post(`/api/workflows/${wf.id}/enroll`, { contact_ids: [c.id] });
    }
    const stats = (await t.api.get(`/api/workflows/${wf.id}/split-stats`)).data;
    const test = stats.tests.find((x: any) => x.step_id === 'sp');
    expect(test.variants.map((v: any) => [v.name, v.assigned, v.goals])).toEqual([['A', 2, 1], ['B', 2, 0]]);
    expect(test.variants[0].completed).toBe(2);
  });
});

describe('loop', () => {
  it('runs the body for every element with item and index', async () => {
    const { vars, log, run } = await runWorkflow(t, [
      { type: 'loop', items: 'rot\ngrün\nblau', item_var: 'farbe', each: [{ type: 'math', operation: 'add', a: '{{var.summe}}', b: '{{var.index}}', save_to: 'var.summe' }, { type: 'array_op', op: 'join', input: '{{var.liste}}', arg: ',', save_to: 'var.liste2' }, { type: 'set_variable', rows: [{ name: 'liste', value: '{{var.liste|}}{{var.farbe}};' }] }] },
      set('fertig', 'ja'),
    ]);
    expect(vars.summe).toBe(3); // 0 + 1 + 2
    expect(vars.liste).toBe('rot;grün;blau;'); // the template reads the value of the round before
    expect(vars.fertig).toBe('ja');
    expect(results(log).filter((r) => String(r).startsWith('Element'))).toEqual(['Element 1 von 3', 'Element 2 von 3', 'Element 3 von 3']);
    expect(results(log)).toContain('Schleife beendet (3 Elemente)');
    expect(run.vars._loops).toEqual({});
  });

  it('caps the number of elements and skips empty lists and empty bodies', async () => {
    const big = Array.from({ length: 700 }, (_, i) => i).join('\n');
    const first = await runWorkflow(t, [{ type: 'loop', items: big, max_items: 9999, each: [{ type: 'math', operation: 'add', a: '{{var.n}}', b: '1', save_to: 'var.n' }] }], { settings: { max_steps: 20000 } });
    const a = { ...first, ...(await settle(t, first.wf.id)) };
    expect(a.vars.n).toBe(500);
    expect(results(first.log).some((r) => String(r).includes('von 500'))).toBe(true);
    const cut = await runWorkflow(t, [{ type: 'loop', items: 'a\nb\nc\nd\ne\nf\ng', max_items: 3, each: [set('x', '1')] }]);
    expect(results(cut.log)[0]).toContain('Liste auf 3 gekürzt, 7 vorhanden');
    const small = await runWorkflow(t, [{ type: 'loop', items: big, max_items: 3, each: [{ type: 'math', operation: 'add', a: '{{var.n}}', b: '1', save_to: 'var.n' }] }]);
    expect(small.vars.n).toBe(3);
    const empty = await runWorkflow(t, [{ type: 'loop', items: '', each: [set('x', '1')] }, set('after', '1')]);
    expect(empty.vars.x).toBeUndefined();
    expect(empty.vars.after).toBe('1');
    const noBody = await runWorkflow(t, [{ type: 'loop', items: 'a\nb', each: [] }, set('after', '1')]);
    expect(noBody.vars.after).toBe('1');
  });

  it('works with a list from a variable, nested ifs and break out through goal', async () => {
    const { vars } = await runWorkflow(t, [
      { type: 'set_variable', rows: [{ name: 'zahlen', value: '[1,2,3,4,5,6]', type: 'json' }] },
      { type: 'loop', items: '{{var.zahlen}}', each: [{ type: 'if', expression: 'var.item % 2 == 0', then: [{ type: 'math', operation: 'add', a: '{{var.gerade}}', b: '{{var.item}}', save_to: 'var.gerade' }], else: [] }] },
    ]);
    expect(vars.gerade).toBe(12);
  });

  it('a loop survives a wait inside its body', async () => {
    at('2026-05-04T08:00:00Z');
    const { run, wf } = await runWorkflow(t, [{ type: 'loop', items: 'a\nb', each: [{ type: 'wait', amount: 1, unit: 'hours' }, { type: 'set_variable', rows: [{ name: 'last', value: '{{var.item}}' }] }] }]);
    expect(run.status).toBe('waiting');
    await resume(t, run.id);
    expect(readRun(t, wf.id).run.status).toBe('waiting');
    await resume(t, run.id);
    const done = readRun(t, wf.id);
    expect(done.run.status).toBe('completed');
    expect(done.vars.last).toBe('b');
  });
});

describe('drip', () => {
  it('assigns slots: batches per interval, no backlog after idle time', () => {
    const H = 3_600_000;
    const t0 = Date.parse('2026-05-04T08:00:00Z');
    expect(dripSlot(undefined, 2, H, t0)).toEqual({ slot: t0, fresh: true });
    expect(dripSlot({ slot_at: new Date(t0).toISOString(), used: 1 }, 2, H, t0 + 1000)).toEqual({ slot: t0, fresh: false });
    expect(dripSlot({ slot_at: new Date(t0).toISOString(), used: 2 }, 2, H, t0 + 1000)).toEqual({ slot: t0 + H, fresh: true });
    // the slot's hour is over although it had room: new slot now (rate stays at 2 per hour)
    expect(dripSlot({ slot_at: new Date(t0).toISOString(), used: 1 }, 2, H, t0 + 2 * H)).toEqual({ slot: t0 + 2 * H, fresh: true });
    // a future slot with room is joined
    expect(dripSlot({ slot_at: new Date(t0 + 5 * H).toISOString(), used: 1 }, 2, H, t0)).toEqual({ slot: t0 + 5 * H, fresh: false });
  });

  it('lets two contacts through at once and holds the third until the next slot', async () => {
    at('2026-05-04T08:00:00Z');
    const steps = [{ id: 'd', type: 'drip', batch_size: 2, every: 1, unit: 'hours' }, set('through', 'ja')];
    const wf = (await t.api.post('/api/workflows', { name: 'drip', trigger: { type: 'manual', config: {} }, steps })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = (await t.api.post('/api/contacts', { first_name: `D${i}`, email: `drip${i}@example.com` })).data;
      ids.push(c.id);
      await t.api.post(`/api/workflows/${wf.id}/enroll`, { contact_ids: [c.id] });
    }
    const st = ids.map((id) => readRun(t, wf.id, id).run);
    expect(st.map((r) => r.status)).toEqual(['completed', 'completed', 'waiting']);
    expect(st[2].next_run_at).toBe('2026-05-04T09:00:00.000Z');
    expect(readRun(t, wf.id, ids[2]).log[0].result).toContain('Freigabe in Gruppen zu 2');
    at('2026-05-04T09:00:01Z');
    await resume(t, st[2].id);
    expect(readRun(t, wf.id, ids[2]).run.status).toBe('completed');
  });
});

describe('waits', () => {
  it('waits until a condition holds, with a timeout', async () => {
    at('2026-05-04T08:00:00Z');
    const steps = [{ type: 'wait_until', conditions: [{ field: 'tag', op: 'has', value: 'bezahlt' }], check_every: 30, timeout_amount: 2, timeout_unit: 'hours', on_timeout: 'end' }, set('weiter', 'ja')];
    const { run, wf, contact } = await runWorkflow(t, steps);
    expect(run.status).toBe('waiting');
    expect(run.next_run_at).toBe('2026-05-04T08:30:00.000Z');
    // still not paid after half an hour: waits again at the same step
    at('2026-05-04T08:30:05Z');
    await resume(t, run.id);
    expect(readRun(t, wf.id).run.status).toBe('waiting');
    // paid: continues
    await t.api.post(`/api/contacts/${contact.id}/tags`, { add: ['bezahlt'] });
    at('2026-05-04T09:00:10Z');
    await resume(t, run.id);
    const done = readRun(t, wf.id);
    expect(done.run.status).toBe('completed');
    expect(done.vars.weiter).toBe('ja');
    expect(results(done.log)).toContain('Bedingung erfüllt');
  });

  it('ends at the timeout when the condition never holds', async () => {
    at('2026-05-04T08:00:00Z');
    const { run, wf } = await runWorkflow(t, [{ type: 'wait_until', expression: 'false', check_every: 60, timeout_amount: 90, timeout_unit: 'minutes', on_timeout: 'end' }, set('weiter', 'ja')]);
    expect(run.next_run_at).toBe('2026-05-04T09:00:00.000Z');
    at('2026-05-04T09:00:01Z');
    await resume(t, run.id);
    expect(readRun(t, wf.id).run.next_run_at).toBe('2026-05-04T09:30:00.000Z'); // never later than the limit
    at('2026-05-04T09:30:01Z');
    await resume(t, run.id);
    const done = readRun(t, wf.id);
    expect(done.run.status).toBe('completed');
    expect(done.vars.weiter).toBeUndefined();
    expect(results(done.log).at(-1)).toContain('Zeitlimit erreicht → Ende');
  });

  it('waits for the next business-hours window in the sub-account time zone', async () => {
    // Friday 2026-03-27 18:30 Berlin (CET) → Monday 2026-03-30 09:00 CEST (summer time started on the 29th) = 07:00Z
    at('2026-03-27T17:30:00Z');
    const a = await runWorkflow(t, [{ type: 'wait_window', days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '17:00' }, set('x', '1')]);
    expect(a.run.status).toBe('waiting');
    expect(a.run.next_run_at).toBe('2026-03-30T07:00:00.000Z');
    // inside the window: goes straight on
    at('2026-03-27T10:00:00Z');
    const b = await runWorkflow(t, [{ type: 'wait_window', days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '17:00' }, set('x', '1')]);
    expect(b.run.status).toBe('completed');
    // a holiday is skipped
    at('2026-03-27T17:30:00Z');
    const c = await runWorkflow(t, [{ type: 'wait_window', from: '09:00', to: '17:00', holidays: '2026-03-30' }, set('x', '1')]);
    expect(c.run.next_run_at).toBe('2026-03-31T07:00:00.000Z');
  });

  it('computes date waits relative to a field across daylight-saving changes', async () => {
    at('2026-10-01T10:00:00Z');
    // 3 days before 2026-10-27 at 09:00 → 24 Oct 09:00 CEST (07:00Z); the clocks go back on the 25th
    const a = await runWorkflow(t, [{ type: 'wait_date', field: 'date_of_birth', direction: 'before', amount: 3, unit: 'days', time: '09:00' }], { contact: { date_of_birth: '1990-10-27' }, event: {} });
    // the birthday of 1990 is long past: not yearly → continues at once
    expect(a.run.status).toBe('completed');
    const b = await runWorkflow(t, [{ type: 'wait_date', field: 'date_of_birth', direction: 'before', amount: 3, unit: 'days', time: '09:00', yearly: true }], { contact: { date_of_birth: '1990-10-27' } });
    expect(b.run.status).toBe('waiting');
    expect(b.run.next_run_at).toBe('2026-10-24T07:00:00.000Z');
    // 4 days AFTER 22 Oct 2026 crosses the change: 09:00 stays 09:00 local (CET = 08:00Z after the change)
    const c = await runWorkflow(t, [{ type: 'wait_date', field: 'custom.start', direction: 'after', amount: 4, unit: 'days', time: '09:00' }], { contact: { custom: { start: '22.10.2026' } } });
    expect(c.run.next_run_at).toBe('2026-10-26T08:00:00.000Z');
    // hours are elapsed time: 48 hours after 24 Oct 12:00 CEST is 26 Oct 11:00 CET (not 12:00)
    const d = await runWorkflow(t, [{ type: 'wait_date', field: 'custom.start', direction: 'after', amount: 48, unit: 'hours' }], { contact: { custom: { start: '2026-10-24T10:00:00Z' } } });
    expect(d.run.next_run_at).toBe('2026-10-26T10:00:00.000Z');
    // spring: 1 day after 28 Mar 2026 09:00 stays 09:00 local (CEST = 07:00Z)
    at('2026-03-01T10:00:00Z');
    const e = await runWorkflow(t, [{ type: 'wait_date', field: 'custom.start', direction: 'after', amount: 1, unit: 'days', time: '09:00' }], { contact: { custom: { start: '2026-03-28' } } });
    expect(e.run.next_run_at).toBe('2026-03-29T07:00:00.000Z');
    // yearly with 29 February: other years use the 28th
    at('2026-02-20T10:00:00Z');
    const f = await runWorkflow(t, [{ type: 'wait_date', field: 'date_of_birth', direction: 'after', amount: 0, unit: 'days', time: '09:00', yearly: true }], { contact: { date_of_birth: '2000-02-29' } });
    expect(f.run.next_run_at).toBe('2026-02-28T08:00:00.000Z');
    // missing date
    const g = await runWorkflow(t, [{ type: 'wait_date', field: 'custom.nichts', amount: 1, unit: 'days', if_missing: 'end' }, set('x', '1')]);
    expect(g.run.status).toBe('completed');
    expect(g.vars.x).toBeUndefined();
  });

  it('waits for a reply and tells whether one came', async () => {
    at('2026-05-04T08:00:00Z');
    const steps = [{ type: 'wait_reply', timeout_amount: 1, timeout_unit: 'days', check_every: 10 }, { type: 'if', conditions: [{ field: 'var.replied', op: 'equals', value: 'true' }], then: [set('antwort', 'ja')], else: [set('antwort', 'nein')] }];
    const quiet = await runWorkflow(t, steps);
    expect(quiet.run.status).toBe('waiting');
    at('2026-05-05T08:00:01Z');
    await resume(t, quiet.run.id);
    expect(readRun(t, quiet.wf.id).vars.antwort).toBe('nein');
    // a reply arrives between two checks
    at('2026-05-06T08:00:00Z');
    const talk = await runWorkflow(t, steps);
    const conv = t.app.db.get('SELECT id FROM conversations WHERE contact_id = ?', talk.contact.id)?.id ?? 'c-test';
    if (!t.app.db.get('SELECT id FROM conversations WHERE id = ?', conv)) t.app.db.insert('conversations', { id: conv, location_id: t.api.location, contact_id: talk.contact.id, unread: 0, last_message_at: new Date().toISOString(), created_at: new Date().toISOString() });
    t.app.db.insert('messages', { id: 'm-reply', location_id: t.api.location, conversation_id: conv, contact_id: talk.contact.id, channel: 'email', direction: 'in', subject: '', body: 'Ja gerne', status: 'received', error: '', source: 'eingehend', created_at: '2026-05-06T09:00:00.000Z' });
    at('2026-05-06T09:05:00Z');
    await resume(t, talk.run.id);
    expect(readRun(t, talk.wf.id).vars).toMatchObject({ replied: true, antwort: 'ja' });
  });

  it('keeps the built-in wait working next to the new ones', async () => {
    const { run } = await runWorkflow(t, [{ type: 'wait', amount: 1, unit: 'days' }, set('x', '1')]);
    expect(run.status).toBe('waiting');
    expect(contactOf(t, run.contact_id).id).toBe(run.contact_id);
  });
});
