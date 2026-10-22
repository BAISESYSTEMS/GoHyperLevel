import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contactOf, newApp, readRun, results, runWorkflow, type T } from './wfx-helpers.js';

/**
 * The older core steps that had no test of their own (tags, DND, deals, review request, workflow membership, goal, team
 * notice, ticket) and what they do when the service behind them is not set up. Mail and SMS are "nur speichern" in tests.
 */

let t: T;
let loc = '';
beforeAll(async () => {
  t = await newApp();
  loc = t.api.location;
});
afterAll(() => t.close());
const set = (name: string, value: string) => ({ type: 'set_variable', rows: [{ name, value }] });

describe('tags, DND and goal', () => {
  it('adds and removes tags (only the named ones) and sets and clears Nicht stören', async () => {
    const r = await runWorkflow(t, [{ type: 'add_tag', tags: ['kunde', 'vip', 'alt'] }, { type: 'remove_tag', tags: ['alt', 'gibt-es-nicht'] }, { type: 'set_dnd', value: true }], { contact: { tags: ['lead'] } });
    const c = contactOf(t, r.contact.id);
    expect([...c.tags].sort()).toEqual(['kunde', 'lead', 'vip']);
    expect(c.dnd).toBe(1);
    expect(results(r.log)).toEqual(['kunde, vip, alt', 'alt, gibt-es-nicht', 'DND an']);
    const again = await runWorkflow(t, [{ type: 'set_dnd', value: false }], { contact: { dnd: 1 } });
    expect(contactOf(t, again.contact.id).dnd).toBe(0);
    expect(results(again.log)).toEqual(['DND aus']);
  });

  it('a goal that is reached ends the flow early, otherwise it goes on', async () => {
    const reached = await runWorkflow(t, [{ type: 'goal', conditions: [{ field: 'tag', op: 'has', value: 'termin' }] }, set('danach', 'ja')], { contact: { tags: ['termin'] } });
    expect(reached.log.map((l) => l.result)).toEqual(['erreicht']);
    expect(reached.vars.danach).toBeUndefined();
    expect(reached.run.status).toBe('completed');
    const open = await runWorkflow(t, [{ type: 'goal', conditions: [{ field: 'tag', op: 'has', value: 'termin' }] }, set('danach', 'ja')]);
    expect(open.vars.danach).toBe('ja');
  });
});

describe('deals and the review request', () => {
  it('creates a deal for the contact and sets the status of the newest one', async () => {
    const pipe = (await t.api.post('/api/pipelines', { name: 'Neukunden', stages: ['Neu', 'Gespräch'] })).data;
    const r = await runWorkflow(t, [{ type: 'create_opportunity', pipeline_id: pipe.id, stage_id: pipe.stages[1].id, name: 'Paket für {{contact.first_name}}', value: '1.200' }, { type: 'set_opportunity_status', pipeline_id: pipe.id, status: 'won' }, { type: 'set_opportunity_status', pipeline_id: 'andere-pipeline', status: 'lost' }]);
    const deal = t.app.db.get<any>('SELECT * FROM opportunities WHERE contact_id = ?', r.contact.id)!;
    expect(deal).toMatchObject({ name: 'Paket für Erika', stage_id: pipe.stages[1].id, status: 'won', pipeline_id: pipe.id });
    expect(results(r.log)[2]).toBe('keine Opportunity');
    expect(t.app.db.all('SELECT id FROM opportunities WHERE location_id = ? AND contact_id = ?', loc, r.contact.id)).toHaveLength(1);
  });

  it('sends a review request by e-mail with a personal link and records it for the sub-account', async () => {
    const r = await runWorkflow(t, [{ type: 'review_request', channel: 'email' }]);
    expect(results(r.log)).toEqual(['Bewertungsanfrage gesendet']);
    const req = t.app.db.all<any>('SELECT * FROM review_requests WHERE contact_id = ?', r.contact.id);
    expect(req).toHaveLength(1);
    const msg = t.app.db.get<any>(`SELECT * FROM messages WHERE contact_id = ? AND direction = 'out' ORDER BY created_at DESC`, r.contact.id)!;
    expect(msg.body).toContain(`/r/${req[0].token}`);
    // the request belongs to the sub-account of the run
    expect(req[0].location_id).toBe(loc);
  });
});

describe('workflow membership', () => {
  const mk = async (name: string, status: string, steps: any[]) => {
    const w = (await t.api.post('/api/workflows', { name, trigger: { type: 'manual', config: {} }, steps })).data;
    if (status === 'active') await t.api.patch(`/api/workflows/${w.id}`, { status });
    return w;
  };

  it('adds the contact to another active workflow once, and refuses a workflow that is not active', async () => {
    const target = await mk('Nachfassen', 'active', [{ type: 'wait', amount: 3, unit: 'days' }, set('fertig', 'ja')]);
    const paused = await mk('Pausiert', 'draft', [set('x', '1')]);
    const r = await runWorkflow(t, [{ type: 'add_to_workflow', workflow_id: target.id }, { type: 'add_to_workflow', workflow_id: target.id }, { type: 'add_to_workflow', workflow_id: paused.id }]);
    await new Promise((res) => setTimeout(res, 30));
    expect(results(r.log)).toEqual(['gestartet', 'schon drin', 'Ziel-Workflow nicht aktiv']);
    expect(readRun(t, target.id, r.contact.id).run.status).toBe('waiting');
    expect(readRun(t, paused.id, r.contact.id).run).toBeUndefined();
  });

  it('removes only the contact of the run from the other workflow', async () => {
    const target = await mk('Serie', 'active', [{ type: 'wait', amount: 3, unit: 'days' }, set('fertig', 'ja')]);
    const a = await runWorkflow(t, [{ type: 'add_to_workflow', workflow_id: target.id }]);
    const b = await runWorkflow(t, [{ type: 'add_to_workflow', workflow_id: target.id }]);
    await new Promise((res) => setTimeout(res, 30));
    expect(readRun(t, target.id, a.contact.id).run.status).toBe('waiting');
    expect(readRun(t, target.id, b.contact.id).run.status).toBe('waiting');
    const rm = await mk('Raus', 'active', [{ type: 'remove_from_workflow', workflow_id: target.id }]);
    await t.api.post(`/api/workflows/${rm.id}/enroll`, { contact_ids: [a.contact.id] });
    expect(results(readRun(t, rm.id, a.contact.id).log)).toEqual(['entfernt']);
    expect(readRun(t, target.id, a.contact.id).run.status).toBe('stopped');
    expect(readRun(t, target.id, b.contact.id).run.status).toBe('waiting');
  });
});

describe('team notice and steps whose service is not set up', () => {
  it('"Team benachrichtigen" reaches the team without a contact name in the way', async () => {
    const r = await runWorkflow(t, [{ type: 'notify', subject: 'Neuer Lead {{contact.first_name}}', body: 'Bitte melden.' }]);
    expect(results(r.log)).toEqual(['Team benachrichtigt']);
  });

  it('creates a ticket for the contact', async () => {
    const r = await runWorkflow(t, [{ type: 'ticket_create', subject: 'Rückruf für {{contact.first_name}}', description: 'Automatisch angelegt', priority: 'hoch' }]);
    expect(results(r.log)[0]).toMatch(/^Ticket #\d+ angelegt$/);
    const ticket = t.app.db.get<any>('SELECT * FROM tickets WHERE contact_id = ?', r.contact.id)!;
    expect(ticket).toMatchObject({ subject: 'Rückruf für Erika', priority: 'hoch', location_id: loc });
  });

  it('Discord, Composio and MCP steps explain what is missing instead of failing silently', async () => {
    const r = await runWorkflow(t, [{ type: 'discord_send', body: 'Hallo' }, { type: 'composio_ai', prompt: 'Tue etwas' }, { type: 'mcp_tool', server_id: 'gibt-es-nicht', tool: 'x', args: {} }, set('weiter', 'ja')]);
    const logs = r.log.slice(0, 3);
    for (const l of logs) {
      expect(l.error, JSON.stringify(l)).toBeTruthy();
      expect(String(l.error)).not.toMatch(/TypeError|undefined|Cannot read/);
    }
    // the run continues after a failed step (unless the workflow says "bei Fehler stoppen")
    expect(r.vars.weiter).toBe('ja');
  });
});

describe('triggers that only needed the event', () => {
  const started = async (type: string, data: Record<string, unknown> = {}, config: Record<string, unknown> = {}) => {
    const c = (await t.api.post('/api/contacts', { first_name: 'Lena', email: `${type.replace(/\W/g, '')}-${Math.random().toString(36).slice(2, 7)}@example.com` })).data;
    const w = (await t.api.post('/api/workflows', { name: `auf ${type}`, trigger: { type, config }, steps: [set('ran', 'ja')] })).data;
    expect(w.id, type).toBeTruthy();
    await t.api.patch(`/api/workflows/${w.id}`, { status: 'active' });
    t.app.events.emit(loc, type, { contactId: c.id, ...data });
    await t.app.events.flush();
    return { run: readRun(t, w.id, c.id).run, wf: w, contact: c };
  };

  it('tag removed: only for the configured tag', async () => {
    expect((await started('contact.tag_removed', { tag: 'kunde' }, { tag: 'kunde' })).run?.vars.ran).toBe('ja');
    expect((await started('contact.tag_removed', { tag: 'anderes' }, { tag: 'kunde' })).run).toBeUndefined();
  });

  it('opportunity created: only for the configured pipeline', async () => {
    expect((await started('opportunity.created', { pipelineId: 'p1' }, { pipeline_id: 'p1' })).run?.vars.ran).toBe('ja');
    expect((await started('opportunity.created', { pipelineId: 'p2' }, { pipeline_id: 'p1' })).run).toBeUndefined();
  });

  it('the plain events start their workflow: unsubscribed, bounced complaint, declined contract, new recurring invoice, accepted estimate, clicked link, finished media', async () => {
    for (const type of ['contact.unsubscribed', 'email.complained', 'contract.declined', 'invoice.created', 'estimate.accepted', 'genmedia.completed', 'company.updated']) {
      expect((await started(type)).run?.vars.ran, type).toBe('ja');
    }
    expect((await started('link.clicked', { linkId: 'l1' }, { link_id: 'l1' })).run?.vars.ran).toBe('ja');
    expect((await started('link.clicked', { linkId: 'l2' }, { link_id: 'l1' })).run).toBeUndefined();
  });

  it('an event of another sub-account never starts the workflow', async () => {
    const other = (await t.api.post('/api/locations', { name: 'Zweitfirma' })).data;
    const c = (await t.api.post('/api/contacts', { first_name: 'Nora', email: 'nora-iso@example.com' })).data;
    const w = (await t.api.post('/api/workflows', { name: 'nur hier', trigger: { type: 'contract.declined', config: {} }, steps: [set('ran', 'ja')] })).data;
    await t.api.patch(`/api/workflows/${w.id}`, { status: 'active' });
    t.app.events.emit(other.id ?? 'unbekannt', 'contract.declined', { contactId: c.id });
    await t.app.events.flush();
    expect(readRun(t, w.id, c.id).run).toBeUndefined();
  });
});
