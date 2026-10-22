import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contactOf, newApp, runWorkflow, type T } from './wfx-helpers.js';
import { PAUSED_RESULT } from '../server/modules/workflow-pause.js';

/** Pause single steps: `disabled: true` keeps the step in the flow, the engine skips it with a log line (docs/workflow-actions.md). */

let t: T;
beforeAll(async () => {
  t = await newApp();
});
afterAll(() => t.close());

const tag = (name: string, extra: Record<string, unknown> = {}) => ({ type: 'add_tag', tags: [name], ...extra });

describe('the engine skips paused steps', () => {
  it('skips a paused action with a log entry and goes on with the next step', async () => {
    const { run, log, contact } = await runWorkflow(t, [tag('eins'), tag('zwei', { disabled: true }), tag('drei')]);
    expect(run.status).toBe('completed');
    expect(contactOf(t, contact.id).tags).toEqual(expect.arrayContaining(['eins', 'drei']));
    expect(contactOf(t, contact.id).tags).not.toContain('zwei');
    const skipped = log.filter((l) => l.skipped);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ type: 'add_tag', result: PAUSED_RESULT, skipped: true });
    expect(log.map((l) => l.type)).toEqual(['add_tag', 'add_tag', 'add_tag']);
  });

  it('a paused container skips its lanes, the flow continues after it', async () => {
    const steps = [
      { type: 'if', disabled: true, conditions: [{ field: 'tag', op: 'not_has', value: 'x' }], match: 'all', then: [tag('ja')], else: [tag('nein')] },
      { type: 'loop', disabled: true, items: 'a\nb', each: [tag('schleife')] },
      tag('danach'),
    ];
    const { run, log, contact } = await runWorkflow(t, steps);
    expect(run.status).toBe('completed');
    const tags = contactOf(t, contact.id).tags;
    expect(tags).toContain('danach');
    for (const x of ['ja', 'nein', 'schleife']) expect(tags).not.toContain(x);
    expect(log.filter((l) => l.skipped).map((l) => l.type)).toEqual(['if', 'loop']);
  });

  it('a paused wait does not wait and a paused end does not end', async () => {
    const { run, log, contact } = await runWorkflow(t, [{ type: 'wait', amount: 2, unit: 'days', disabled: true }, { type: 'end', disabled: true }, tag('weiter')]);
    expect(run.status).toBe('completed');
    expect(run.next_run_at).toBeNull();
    expect(contactOf(t, contact.id).tags).toContain('weiter');
    expect(log.filter((l) => l.skipped)).toHaveLength(2);
  });

  it('a jump onto a paused step goes on with the step after it', async () => {
    const steps = [
      { id: 'jump', type: 'goto', target: 'ziel' },
      tag('uebersprungen'),
      { id: 'ziel', ...tag('ziel'), disabled: true },
      tag('nach-ziel'),
    ];
    const { run, log, contact } = await runWorkflow(t, steps);
    expect(run.status).toBe('completed');
    const tags = contactOf(t, contact.id).tags;
    expect(tags).toContain('nach-ziel');
    expect(tags).not.toContain('ziel');
    expect(tags).not.toContain('uebersprungen');
    expect(log.find((l) => l.step === 'ziel')).toMatchObject({ skipped: true });
  });

  it('paused steps inside a lane are skipped while the rest of the lane runs', async () => {
    const steps = [{ type: 'if', conditions: [{ field: 'tag', op: 'not_has', value: 'nie' }], match: 'all', then: [tag('a', { disabled: true }), tag('b')], else: [] }];
    const { log, contact } = await runWorkflow(t, steps);
    expect(contactOf(t, contact.id).tags).toEqual(expect.arrayContaining(['b']));
    expect(contactOf(t, contact.id).tags).not.toContain('a');
    expect(log.filter((l) => l.skipped)).toHaveLength(1);
  });
});

describe('saving and test runs', () => {
  it('keeps the flag a plain boolean when a workflow is saved', async () => {
    const r = await t.api.post('/api/workflows', { name: 'Pause speichern', trigger: { type: 'manual', config: {} }, steps: [tag('a', { disabled: 'true' }), tag('b', { disabled: false }), { type: 'if', then: [tag('c', { disabled: 1 })], else: [tag('d', { disabled: true })] }] });
    expect(r.status).toBe(200);
    const [a, b, iff] = r.data.steps;
    expect(a.disabled).toBe(true);
    expect('disabled' in b).toBe(false);
    expect('disabled' in iff.then[0]).toBe(false);
    expect(iff.else[0].disabled).toBe(true);
  });

  it('test runs list the paused steps as skipped and run the rest', async () => {
    const wf = (await t.api.post('/api/workflows', { name: 'Pause testen', trigger: { type: 'manual', config: {} }, steps: [{ type: 'set_variable', rows: [{ name: 'x', value: '1' }] }, tag('pausiert', { disabled: true }), { type: 'end' }] })).data;
    const r = await t.api.post(`/api/workflows/${wf.id}/test-run`, {});
    expect(r.status).toBe(200);
    expect(r.data.status).toBe('completed');
    const entry = r.data.log.find((l: any) => l.type === 'add_tag');
    expect(entry).toMatchObject({ skipped: true, dry: true, result: PAUSED_RESULT });
    // unsaved changes: pausing in the editor and testing without saving
    const draft = await t.api.post(`/api/workflows/${wf.id}/test-run`, { workflow: { steps: [{ type: 'end', disabled: true }, tag('weiter')] } });
    expect(draft.data.log.map((l: any) => [l.type, !!l.skipped])).toEqual([
      ['end', true],
      ['add_tag', false],
    ]);
  });
});
