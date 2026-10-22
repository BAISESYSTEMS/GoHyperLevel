import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cloneWithNewIds, duplicateStep, findStep, insertAt, moveStep, removeStep, slotAfter, slotOf, togglePaused, type Step } from '../web/src/workflow-canvas/model.js';
import { layoutFlow, nearestNode, slotKey, SIZE, type LaneInfo } from '../web/src/workflow-canvas/layout.js';
import { stepStats } from '../web/src/workflow-canvas/stats.js';

/**
 * The visual workflow canvas and the builder tools of both editors (web/src/workflow-canvas): the pure step-tree operations
 * (copy, duplicate, move, delete, pause), the auto-layout with hand-made offsets, the statistics overlay, and that the canvas
 * stays a lazy chunk. docs/workflow-actions.md → The canvas.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const tree = (): Step[] => [
  { id: 'a', type: 'add_tag', tags: ['x'] },
  { id: 'i', type: 'if', conditions: [], then: [{ id: 't1', type: 'send_sms', body: 'hi' }, { id: 't2', type: 'goto', target: 't1' }], else: [{ id: 'e1', type: 'goto', target: 'a' }] },
  { id: 'z', type: 'end' },
];
const lanesOf = (s: Step): LaneInfo[] =>
  s.type === 'if' ? [{ key: 'then', label: 'Ja', tone: 'yes' }, { key: 'else', label: 'Nein', tone: 'no' }] : s.type === 'loop' ? [{ key: 'each', label: 'Für jedes Element' }] : [];

describe('step tree operations (list and canvas)', () => {
  it('finds, inserts and removes anywhere in the tree without touching the input', () => {
    const t = tree();
    const frozen = JSON.stringify(t);
    expect(slotOf(t, 't2')).toEqual({ parent: 'i', key: 'then', index: 1 });
    const added = insertAt(t, { parent: 'i', key: 'else', index: 0 }, [{ id: 'n', type: 'add_note' }]);
    expect(findStep(added, 'i')!.else.map((s: Step) => s.id)).toEqual(['n', 'e1']);
    expect(removeStep(added, 'i').map((s) => s.id)).toEqual(['a', 'z']);
    expect(JSON.stringify(t)).toBe(frozen);
    expect(slotAfter(t, 't1')).toEqual({ parent: 'i', key: 'then', index: 1 });
    expect(slotAfter(t, null)).toEqual({ parent: null, key: 'steps', index: 3 });
  });

  it('moves a step into another lane and refuses to move a container into itself', () => {
    const moved = moveStep(tree(), 'a', { parent: 'i', key: 'else', index: 1 })!;
    expect(moved.map((s) => s.id)).toEqual(['i', 'z']);
    expect(findStep(moved, 'i')!.else.map((s: Step) => s.id)).toEqual(['e1', 'a']);
    // down within the same list: the position counts before the move
    expect(moveStep(tree(), 'a', { parent: null, key: 'steps', index: 3 })!.map((s) => s.id)).toEqual(['i', 'z', 'a']);
    expect(moveStep(tree(), 'i', { parent: 'i', key: 'then', index: 0 })).toBeNull();
  });

  it('duplicates with new ids – jumps inside the copy follow it, jumps outside stay', () => {
    let n = 0;
    const [copy] = cloneWithNewIds([tree()[1]], () => `c${++n}`);
    expect(copy.id).toBe('c1');
    expect(copy.then[1].target, 'jump inside the copy').toBe(copy.then[0].id);
    expect(copy.else[0].target, 'jump outside stays').toBe('a');
    const { steps, copy: dup } = duplicateStep(tree(), 'a');
    expect(steps.map((s) => s.id)).toEqual(['a', dup!.id, 'i', 'z']);
    expect(dup!.tags).toEqual(['x']);
  });

  it('pauses and resumes a step with disabled: true', () => {
    const paused = togglePaused(tree(), 't1');
    expect(findStep(paused, 't1')!.disabled).toBe(true);
    expect('disabled' in findStep(togglePaused(paused, 't1'), 't1')!).toBe(false);
  });
});

describe('auto-layout', () => {
  it('places trigger, steps, lane headers and END pills and an insert point on every connector', () => {
    const steps: Step[] = [{ id: 'a', type: 'add_tag' }, { id: 'i', type: 'if', then: [{ id: 't1', type: 'send_sms' }], else: [] }];
    const lay = layoutFlow(steps, lanesOf);
    const byKey = Object.fromEntries(lay.nodes.map((n) => [n.key, n]));
    expect(Object.keys(byKey).sort()).toEqual(['a', 'end', 'i', 'i/else', 'i/then', 't1', 'trigger']);
    expect(byKey.trigger.kind).toBe('trigger');
    expect(byKey['i/then'].kind).toBe('branch');
    expect(byKey.end.kind).toBe('end');
    // top to bottom, lanes side by side
    expect(byKey.a.y).toBe(SIZE.nodeH + SIZE.gapY);
    expect(byKey['i/then'].x).toBeLessThan(byKey['i/else'].x);
    expect(byKey.t1.y).toBeGreaterThan(byKey['i/then'].y);
    expect(byKey.end.y).toBeGreaterThan(byKey.t1.y);
    expect(lay.inserts.map((p) => slotKey(p.slot)).sort()).toEqual(['i/else/0', 'i/then/0', 'i/then/1', 'root/steps/0', 'root/steps/1', 'root/steps/2'].sort());
    expect(lay.edges.filter((e) => e.tone === 'yes')).toHaveLength(1);
    expect(lay.joins).toHaveLength(1);
  });

  it('a lane that ends with "Ende" gets its own END pill and does not join; a loop draws its way back', () => {
    const steps: Step[] = [
      { id: 'i', type: 'if', then: [{ id: 'stop', type: 'end' }], else: [{ id: 'b', type: 'add_tag' }] },
      { id: 'l', type: 'loop', each: [{ id: 'x', type: 'add_tag' }] },
    ];
    const lay = layoutFlow(steps, lanesOf);
    expect(lay.nodes.some((n) => n.key === 'stop:end' && n.kind === 'end')).toBe(true);
    expect(lay.inserts.some((p) => p.slot.parent === 'i' && p.slot.key === 'then' && p.slot.index === 1)).toBe(false);
    expect(lay.edges.filter((e) => e.loop)).toHaveLength(1);
    expect(layoutFlow([], lanesOf, {}, { trigger: false }).nodes[0].kind).toBe('add-trigger');
  });

  it('hand-made offsets move a node, and a container moves everything inside it', () => {
    const steps: Step[] = [{ id: 'i', type: 'if', then: [{ id: 't1', type: 'send_sms' }], else: [] }];
    const auto = Object.fromEntries(layoutFlow(steps, lanesOf).nodes.map((n) => [n.key, n]));
    const moved = Object.fromEntries(layoutFlow(steps, lanesOf, { i: [100, 20], t1: [5, 0] }).nodes.map((n) => [n.key, n]));
    expect([moved.i.x - auto.i.x, moved.i.y - auto.i.y]).toEqual([100, 20]);
    expect([moved['i/then'].x - auto['i/then'].x, moved.t1.x - auto.t1.x]).toEqual([100, 105]);
    expect(moved.trigger.x).toBe(auto.trigger.x);
  });

  it('arrow keys find the nearest node in a direction', () => {
    const lay = layoutFlow([{ id: 'i', type: 'if', then: [{ id: 'l', type: 'add_tag' }], else: [{ id: 'r', type: 'add_tag' }] }], lanesOf);
    const n = (k: string) => lay.nodes.find((x) => x.key === k)!;
    expect(nearestNode(lay.nodes, n('l'), 'right')?.key).toBe('r');
    expect(nearestNode(lay.nodes, n('r'), 'left')?.key).toBe('l');
    expect(nearestNode(lay.nodes, n('i'), 'up')?.key).toBe('trigger');
  });
});

describe('statistics overlay', () => {
  it('counts passes, errors, skipped (paused) steps and who waits where, from the runs the editor loads', () => {
    const runs = [{ log: [{ step: 'a', result: 'ok' }, { step: 'b', error: 'kaputt' }] }, { log: [{ step: 'a', result: 'ok' }, { step: 'b', skipped: true, result: 'Übersprungen' }] }];
    expect(stepStats(runs, { c: 3 })).toEqual({
      a: { done: 2, errors: 0, skipped: 0, waiting: 0 },
      b: { done: 0, errors: 1, skipped: 1, waiting: 0 },
      c: { done: 0, errors: 0, skipped: 0, waiting: 3 },
    });
  });
});

describe('module boundaries', () => {
  const walk = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((f) => (statSync(join(ROOT, dir, f)).isDirectory() ? walk(`${dir}/${f}`) : [`${dir}/${f}`]));

  it('the canvas is a lazy chunk: nothing imports WorkflowCanvas statically', () => {
    const offenders = walk('web/src').filter((f) => /\.tsx?$/.test(f) && !f.includes('/workflow-canvas/WorkflowCanvas')).filter((f) => /import [^;]*from '[^']*workflow-canvas\/WorkflowCanvas'/.test(read(f)));
    expect(offenders).toEqual([]);
    expect(read('web/src/pages/Workflows.tsx')).toMatch(/lazyPages\(\(\) => import\('\.\.\/workflow-canvas\/WorkflowCanvas'\), 'WorkflowCanvas'\)/);
  });

  it('the builder features are modules of their own, registered in the module index', () => {
    const index = read('server/modules/index.ts');
    for (const m of ['workflowPauseModule', 'workflowValidateModule', 'workflowClipboardModule', 'workflowCanvasModule']) expect(index, m).toContain(`  ${m},`);
    // the workflow routes stay untouched: validation and layout plug in through router wrappers
    expect(read('server/modules/workflows.ts')).not.toMatch(/layout|issues|disabled|workflow-validate/);
  });
});
