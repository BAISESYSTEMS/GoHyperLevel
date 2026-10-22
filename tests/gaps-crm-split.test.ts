import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideWinner } from '../server/modules/split-winner.js';
import { startTestApp } from './helpers.js';

/** Split test with an automatic winner (modules/split-winner.ts). */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
});
afterAll(() => t?.close());

describe('split test auto winner', () => {
  it('decides only with enough contacts and a significant lead', () => {
    expect(decideWinner([{ index: 0, name: 'A', assigned: 50, goals: 5 }, { index: 1, name: 'B', assigned: 50, goals: 25 }])).toBeNull();
    expect(decideWinner([{ index: 0, name: 'A', assigned: 120, goals: 30 }, { index: 1, name: 'B', assigned: 120, goals: 33 }])).toBeNull();
    expect(decideWinner([{ index: 0, name: 'A', assigned: 120, goals: 12 }, { index: 1, name: 'B', assigned: 120, goals: 48 }])).toMatchObject({ index: 1, name: 'B', rate: 40 });
    // Three paths: the best must beat every other one.
    expect(decideWinner([{ index: 0, name: 'A', assigned: 150, goals: 15 }, { index: 1, name: 'B', assigned: 150, goals: 60 }, { index: 2, name: 'C', assigned: 150, goals: 57 }])).toBeNull();
  });

  it('adds the option to the step form and moves all traffic to the winning path once', async () => {
    const meta = (t.app.services.workflowActionMeta as any).split_test;
    expect(meta.fields.some((f: any) => f.key === 'auto_winner')).toBe(true);
    const steps = [{ id: 'sp', type: 'split_test', name: 'Betreff', auto_winner: true, variants: [{ name: 'A', weight: 50 }, { name: 'B', weight: 50 }], b0: [], b1: [] }];
    const wf = (await t.api.post('/api/workflows', { name: 'Betreff-Test', trigger: { type: 'contact.created' }, steps })).data;
    // the contact exists before the workflow goes live – its own contact.created run must not join the sample
    const c = (await t.api.post('/api/contacts', { email: 'x@example.com' })).data.id;
    expect((await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' })).status).toBe(200);
    const at = new Date().toISOString();
    t.app.db.tx(() => {
      for (let v = 0; v < 2; v++)
        for (let i = 0; i < 120; i++) {
          const rid = `r${v}-${i}`;
          const goal = v === 1 ? i < 48 : i < 12;
          t.app.db.run(`INSERT INTO workflow_runs (id, workflow_id, location_id, contact_id, status, log, created_at, updated_at) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)`, rid, wf.id, loc, c, JSON.stringify(goal ? [{ type: 'goal', result: 'erreicht' }] : []), at, at);
          t.app.db.run(`INSERT INTO wfx_split (id, workflow_id, step_id, run_id, contact_id, variant, name, created_at) VALUES (?, ?, 'sp', ?, ?, ?, ?, ?)`, `s${v}-${i}`, wf.id, rid, c, v, v ? 'B' : 'A', at);
        }
    });
    const check = t.app.services.splitWinnerCheck as () => any[];
    expect(check()).toEqual([{ workflowId: wf.id, stepId: 'sp', winner: 'B' }]);
    const step = JSON.parse(t.app.db.get<{ steps: string }>('SELECT steps FROM workflows WHERE id = ?', wf.id)!.steps)[0];
    expect(step.variants.map((v: any) => v.weight)).toEqual([0, 100]);
    expect(step.auto_winner_result).toMatchObject({ variant: 1, name: 'B', goal_rate: 40 });
    expect(check()).toEqual([]);
    // Paused workflows and steps without the option are left alone.
    const off = (await t.api.post('/api/workflows', { name: 'Ohne', trigger: { type: 'contact.created' }, steps: [{ ...steps[0], auto_winner: false }] })).data;
    await t.api.patch(`/api/workflows/${off.id}`, { status: 'active' });
    expect(check()).toEqual([]);
  });
});
