import { startTestApp } from './helpers.js';
import { processRun } from '../server/services/workflow-engine.js';

export type T = Awaited<ReturnType<typeof startTestApp>>;

export async function newApp(): Promise<T> {
  const t = await startTestApp();
  await t.setup();
  return t;
}

export interface RunOpts {
  contact?: Record<string, unknown>;
  trigger?: { type: string; config?: Record<string, unknown> };
  settings?: Record<string, unknown>;
  /** Event data of the run (as if the trigger had delivered it). */
  event?: Record<string, unknown>;
}

/** Creates an active workflow, enrols a contact and returns the run once it stopped (done, waiting or failed). */
export async function runWorkflow(t: T, steps: any[], opts: RunOpts = {}) {
  const contact = (await t.api.post('/api/contacts', { first_name: 'Erika', last_name: 'Muster', email: `erika${Math.random().toString(36).slice(2, 8)}@example.com`, ...(opts.contact ?? {}) })).data;
  const created = await t.api.post('/api/workflows', { name: `wf ${Math.random()}`, trigger: opts.trigger ?? { type: 'manual', config: {} }, steps, settings: opts.settings });
  if (created.status !== 200) throw new Error(`workflow rejected: ${JSON.stringify(created.data)}`);
  const wf = created.data;
  await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
  if (opts.event) {
    // start by hand with a custom event payload
    const { startWorkflow } = await import('../server/services/workflow-engine.js');
    const row = t.app.db.get('SELECT * FROM workflows WHERE id = ?', wf.id)!;
    const parsed = { ...row, steps: JSON.parse(row.steps), trigger: JSON.parse(row.trigger), settings: JSON.parse(row.settings) };
    const rid = startWorkflow(t.app, parsed, contact.id, opts.event);
    if (rid) await processRun(t.app, rid);
  } else {
    await t.api.post(`/api/workflows/${wf.id}/enroll`, { contact_ids: [contact.id] });
  }
  return { wf, contact, ...readRun(t, wf.id) };
}

export function readRun(t: T, workflowId: string, contactId?: string) {
  const row = t.app.db.get(`SELECT * FROM workflow_runs WHERE workflow_id = ? ${contactId ? 'AND contact_id = ?' : ''} ORDER BY created_at DESC LIMIT 1`, workflowId, ...(contactId ? [contactId] : []));
  if (!row) return { run: undefined as any, log: [] as any[], vars: {} as Record<string, any> };
  const run = { ...row, cursor: JSON.parse(row.cursor), log: JSON.parse(row.log), vars: JSON.parse(row.vars || '{}'), event: JSON.parse(row.event || '{}') };
  return { run, log: run.log as any[], vars: run.vars as Record<string, any> };
}

/** Pretend the wait is over and let the scheduler pick the run up. */
export async function resume(t: T, runId: string) {
  t.app.db.run(`UPDATE workflow_runs SET next_run_at = ? WHERE id = ?`, new Date(Date.now() - 1000).toISOString(), runId);
  await processRun(t.app, runId);
}

export const results = (log: any[]) => log.map((l) => l.error ?? l.result);
export const contactOf = (t: T, id: string) => {
  const c = t.app.db.get('SELECT * FROM contacts WHERE id = ?', id)!;
  return { ...c, tags: JSON.parse(c.tags), custom: JSON.parse(c.custom) };
};

/** Waits until a long run has finished its passes (a run over its pass budget carries on by itself). */
export async function settle(t: T, workflowId: string, contactId?: string) {
  for (let i = 0; i < 400; i++) {
    const { run } = readRun(t, workflowId, contactId);
    if (run && !['active', 'running'].includes(run.status)) return readRun(t, workflowId, contactId);
    await new Promise((r) => setTimeout(r, 5));
  }
  return readRun(t, workflowId, contactId);
}
