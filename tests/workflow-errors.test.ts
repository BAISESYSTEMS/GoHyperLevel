import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { newApp, readRun, runWorkflow, type T } from './wfx-helpers.js';
import { cleanErrorSettings, stepLabel } from '../server/services/workflow-errors.js';
import { remapRefs } from '../server/services/snapshots.js';

/** Workflow error handling: "Fehler ignorieren und weiter", an error workflow, bell and e-mail notices, repeating a stopped run. */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

let t: T;
let loc = '';
const mails: { to: string; subject: string; text: string }[] = [];
const pushes: any[] = [];
let realPush: any;
const events: any[] = [];

/** A step that always fails (no URL) and one that works. */
const boom = (extra: Record<string, unknown> = {}) => ({ type: 'webhook', url: '', ...extra });
const tag = (name: string) => ({ type: 'add_tag', tags: [name] });
const create = async (name: string, steps: any[], settings: Record<string, unknown> = {}, active = true) => {
  const r = await t.api.post('/api/workflows', { name, trigger: { type: 'manual', config: {} }, steps, settings });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  if (active) await t.api.patch(`/api/workflows/${r.data.id}`, { status: 'active' });
  return r.data;
};
const contactOf = async () => (await t.api.post('/api/contacts', { first_name: 'Fehler', last_name: 'Fall', email: `fehler${Math.random().toString(36).slice(2, 8)}@example.com` })).data;
const enroll = async (wf: any, contactId: string) => {
  await t.api.post(`/api/workflows/${wf.id}/enroll`, { contact_ids: [contactId] });
  await t.app.events.flush();
  return readRun(t, wf.id, contactId);
};
const tagsOf = (id: string) => (t.app.db.get<any>('SELECT tags FROM contacts WHERE id = ?', id)!.tags ? JSON.parse(t.app.db.get<any>('SELECT tags FROM contacts WHERE id = ?', id)!.tags) : []) as string[];

beforeAll(async () => {
  t = await newApp();
  loc = t.api.location;
  t.app.services.emailTransports = { capture: async (_l: any, mail: any) => (mails.push({ to: mail.to, subject: mail.subject, text: mail.text }), { status: 'sent' }) };
  realPush = t.app.services.pushNotify;
  t.app.services.pushNotify = async (input: any) => void pushes.push(input);
  await t.api.patch('/api/location', { email: 'team@example.com', settings: { email: { provider: 'capture' } } });
  t.app.events.on('*', (e) => void events.push(e));
});
afterAll(() => t.close());

describe('per step: Fehler ignorieren und weiter', () => {
  it('keeps going when the workflow stops on errors, marks the log and reports nothing', async () => {
    mails.length = 0;
    const wf = await create('Ignorieren', [tag('vorher'), boom({ continue_on_error: true }), tag('nachher')], { stop_on_error: true, error_email: true });
    const c = await contactOf();
    const { run, log } = await enroll(wf, c.id);
    expect(run.status).toBe('completed');
    expect(tagsOf(c.id)).toEqual(expect.arrayContaining(['vorher', 'nachher']));
    expect(log.find((l: any) => l.error)).toMatchObject({ type: 'webhook', ignored: true });
    expect(mails).toHaveLength(0);
    expect(events.filter((e) => e.type === 'workflow.step_failed' && e.data.failure?.workflowId === wf.id)).toHaveLength(0);
  });

  it('is kept as a plain flag when the workflow is saved', async () => {
    const wf = await create('Flag', [boom({ continue_on_error: 'true' }), boom({ continue_on_error: 'nein' }), boom({ continue_on_error: false })], {}, false);
    expect(wf.steps.map((s: any) => s.continue_on_error)).toEqual([true, undefined, undefined]);
  });

  it('without the flag the old behaviour stays: a failing step stops the run only when the workflow says so', async () => {
    const go = await runWorkflow(t, [boom(), tag('weiter')]);
    expect(go.run.status).toBe('completed');
    expect(go.log.filter((l) => l.error)).toHaveLength(1);
    const stop = await runWorkflow(t, [boom(), tag('nie')], { settings: { stop_on_error: true } });
    expect(stop.run.status).toBe('failed');
    expect(tagsOf(stop.contact.id)).not.toContain('nie');
  });
});

describe('per workflow: notices and the error workflow', () => {
  it('writes to the team (bell and e-mail) with the failing step, once per run', async () => {
    mails.length = 0;
    pushes.length = 0;
    const wf = await create('Meldet Fehler', [{ type: 'send_sms', body: 'Hallo' }, boom(), boom({ name: 'Zweiter' })], { error_bell: true, error_email: true });
    const c = await contactOf();
    const { run } = await enroll(wf, c.id);
    // the run goes on (no stop on error), the second failure is not announced again
    expect(run.status).toBe('completed');
    expect(mails).toHaveLength(1);
    expect(pushes).toHaveLength(1);
    expect(mails[0].to).toBe('team@example.com');
    expect(mails[0].subject).toBe('Workflow-Fehler: „Meldet Fehler“');
    expect(mails[0].text).toContain('Schritt: SMS senden');
    expect(mails[0].text).toContain('Fehler: ');
    expect(mails[0].text).toContain('Kontakt: Fehler Fall');
    expect(mails[0].text).toContain('läuft mit dem nächsten Schritt weiter');
    expect(mails[0].text).toContain(`/app/workflows/${wf.id}`);
    expect(pushes[0]).toMatchObject({ locationId: loc, kind: 'workflows', title: 'Workflow-Fehler: „Meldet Fehler“', url: `/app/workflows/${wf.id}` });
    expect(pushes[0].body).toContain('SMS senden');
  });

  it('reaches the people of the sub-account through the real push service (log entry per user, own kind)', async () => {
    t.app.services.pushNotify = realPush;
    try {
      const wf = await create('Echte Glocke', [boom()], { error_bell: true });
      await enroll(wf, (await contactOf()).id);
      const row = t.app.db.get<any>(`SELECT kind, title, body, url FROM push_log WHERE title = ?`, 'Workflow-Fehler: „Echte Glocke“');
      expect(row).toMatchObject({ kind: 'workflows', url: `/app/workflows/${wf.id}` });
      expect(row.body).toContain('Webhook aufrufen');
      const kinds = (await t.api.get('/api/push')).data.kinds;
      expect(kinds.workflows).toMatch(/Workflow-Fehler/);
    } finally {
      t.app.services.pushNotify = async (input: any) => void pushes.push(input);
    }
  });

  it('says so when the run was stopped, names the step the way the editor does, and offers only what is switched on', async () => {
    mails.length = 0;
    pushes.length = 0;
    const wf = await create('Hält an', [tag('a'), boom({ name: 'Meine Schnittstelle' })], { stop_on_error: true, error_email: true });
    const { run } = await enroll(wf, (await contactOf()).id);
    expect(run.status).toBe('failed');
    expect(pushes).toHaveLength(0);
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toContain('Schritt: Webhook aufrufen („Meine Schnittstelle“)');
    expect(mails[0].text).toContain('Der Ablauf wurde angehalten');
    expect(stepLabel(t.app, { type: 'unbekannt-xyz' })).toBe('unbekannt-xyz');
  });

  it('stays quiet for workflows without error handling and in test runs', async () => {
    mails.length = 0;
    pushes.length = 0;
    events.length = 0;
    await runWorkflow(t, [boom()]);
    expect(mails).toHaveLength(0);
    const wf = await create('Test', [boom()], { error_email: true, error_bell: true }, false);
    const test = await t.api.post(`/api/workflows/${wf.id}/test-run`, {});
    await t.app.events.flush();
    expect(test.status).toBeLessThan(500);
    expect(mails).toHaveLength(0);
    expect(pushes).toHaveLength(0);
    expect(events.filter((e) => e.type === 'workflow.step_failed')).toHaveLength(0);
  });

  it('caps the notices per workflow and hour', async () => {
    mails.length = 0;
    const wf = await create('Viele Fehler', [boom()], { error_email: true });
    for (let i = 0; i < 13; i++) await enroll(wf, (await contactOf()).id);
    expect(mails).toHaveLength(10);
  });

  it('starts another workflow for the same contact, with the failing step in the event', async () => {
    const handler = await create('Fehlerbehandlung', [{ type: 'add_note', body: 'Fehler in „{{event.error.workflow}}“ bei {{event.error.step}}: {{event.error.message}}' }, tag('fehler-behandelt')]);
    const wf = await create('Quelle', [boom()], { stop_on_error: true, on_error_workflow_id: handler.id });
    expect((await t.api.get(`/api/workflows/${wf.id}`)).data.settings.on_error_workflow_id).toBe(handler.id);
    const c = await contactOf();
    const { run } = await enroll(wf, c.id);
    expect(run.status).toBe('failed');
    const h = readRun(t, handler.id, c.id);
    expect(h.run.status).toBe('completed');
    expect(h.run.event.errorOf).toBe(run.id);
    expect(h.run.event.error).toMatchObject({ workflow: 'Quelle', step: 'Webhook aufrufen', run_id: run.id, stopped: true });
    expect(tagsOf(c.id)).toContain('fehler-behandelt');
    const note = t.app.db.get<any>('SELECT body FROM notes WHERE contact_id = ?', c.id)!;
    expect(note.body).toContain('Fehler in „Quelle“ bei Webhook aufrufen:');
    expect(note.body).toContain('Webhook-URL fehlt');
    // a repeated run that fails again is announced again and starts its own handler run, even for the same contact
    await t.api.post(`/api/workflow-runs/${run.id}/retry`);
    await t.app.events.flush();
    expect(t.app.db.all('SELECT id FROM workflow_runs WHERE workflow_id = ? AND contact_id = ?', handler.id, c.id)).toHaveLength(2);
  });

  it('does not start a handler that is paused, itself, or chains of handlers', async () => {
    const paused = await create('Pausiert', [tag('nie-gestartet')], {}, false);
    const a = await create('A', [boom()], { stop_on_error: true, on_error_workflow_id: paused.id });
    const c1 = await contactOf();
    await enroll(a, c1.id);
    expect(readRun(t, paused.id, c1.id).run).toBeUndefined();

    // handler B fails itself and points back to A: no second handler run, no loop
    const b = await create('B', [boom()], { stop_on_error: true });
    const loop = await create('Schleife', [boom()], { stop_on_error: true, on_error_workflow_id: b.id });
    await t.api.patch(`/api/workflows/${b.id}`, { settings: { on_error_workflow_id: loop.id } });
    const c2 = await contactOf();
    await enroll(loop, c2.id);
    expect(t.app.db.all('SELECT id FROM workflow_runs WHERE workflow_id = ? AND contact_id = ?', loop.id, c2.id)).toHaveLength(1);
    expect(t.app.db.all('SELECT id FROM workflow_runs WHERE workflow_id = ? AND contact_id = ?', b.id, c2.id)).toHaveLength(1);
  });

  it('announces the failure as an event for webhooks and integrations', async () => {
    events.length = 0;
    const wf = await create('Ereignis', [boom()], { error_email: true });
    const c = await contactOf();
    await enroll(wf, c.id);
    const e = events.find((x) => x.type === 'workflow.step_failed' && x.data.failure?.workflowId === wf.id);
    expect(e.data.contactId).toBe(c.id);
    expect(e.data.failure).toMatchObject({ workflowName: 'Ereignis', stepType: 'webhook', step: 'Webhook aufrufen', stopped: false });
    expect(e.data.failure.message).toContain('Webhook-URL fehlt');
  });
});

describe('settings checks', () => {
  it('only accepts a workflow of this sub-account, not the workflow itself', async () => {
    const other = await create('Anderer', [tag('x')], {}, false);
    const wf = await create('Prüfung', [tag('y')], {}, false);
    expect((await t.api.patch(`/api/workflows/${wf.id}`, { settings: { on_error_workflow_id: wf.id } })).status).toBe(400);
    const nope = await t.api.patch(`/api/workflows/${wf.id}`, { settings: { on_error_workflow_id: 'gibtsnicht' } });
    expect(nope.status).toBe(400);
    expect(nope.data.error).toMatch(/Fehler-Workflow/);
    expect((await t.api.post('/api/workflows', { name: 'Neu', settings: { on_error_workflow_id: 'gibtsnicht' } })).status).toBe(400);
    const ok = await t.api.patch(`/api/workflows/${wf.id}`, { settings: { on_error_workflow_id: other.id, error_bell: 'true', error_email: 1 } });
    expect(ok.data.settings).toMatchObject({ on_error_workflow_id: other.id, error_bell: true, error_email: true });
    // a handler that was deleted later does not block other changes, it is dropped
    t.app.db.run('DELETE FROM workflows WHERE id = ?', other.id);
    const after = await t.api.patch(`/api/workflows/${wf.id}`, { settings: { allow_reentry: true } });
    expect(after.status).toBe(200);
    expect(after.data.settings.on_error_workflow_id).toBe('');
    // another sub-account's workflow is not accepted either
    const second = (await t.api.post('/api/locations', { name: 'Zweit' })).data.id;
    const foreign = await t.api.raw('/api/workflows', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pghl': '1', cookie: t.api.cookie, 'x-location-id': second }, body: JSON.stringify({ name: 'Fremd', settings: { on_error_workflow_id: wf.id } }) });
    expect(foreign.status).toBe(400);
  });

  it('is pure for the helper, and a copy of a snapshot points at the copied handler', () => {
    const app = t.app;
    expect(cleanErrorSettings(app, loc, { error_bell: 'true', error_email: 0, x: 1 })).toEqual({ error_bell: true, error_email: false, x: 1 });
    expect(cleanErrorSettings(app, loc, { on_error_workflow_id: '  ' })).toEqual({ on_error_workflow_id: '' });
    const maps = { workflows: new Map([['alt-1', 'neu-1']]) } as any;
    expect(remapRefs({ stop_on_error: true, on_error_workflow_id: 'alt-1' }, maps)).toEqual({ stop_on_error: true, on_error_workflow_id: 'neu-1' });
    expect(remapRefs({ on_error_workflow_id: 'nicht-dabei' }, maps)).toEqual({ on_error_workflow_id: '' });
  });
});

describe('repeat a stopped run from the failed step', () => {
  it('continues at the failing step after it was fixed, without redoing what ran', async () => {
    mails.length = 0;
    const wf = await create('Wiederholen', [tag('eins'), boom({ id: 'kaputt' }), tag('drei')], { stop_on_error: true, error_email: true });
    const c = await contactOf();
    const { run } = await enroll(wf, c.id);
    expect(run.status).toBe('failed');
    expect(run.cursor).toEqual([1]);
    expect(mails).toHaveLength(1);
    // as long as the step is broken, repeating fails again (and tells the team again)
    const again = await t.api.post(`/api/workflow-runs/${run.id}/retry`);
    expect(again.status).toBe(200);
    expect(again.data).toEqual({ id: run.id, status: 'failed' });
    await t.app.events.flush();
    expect(mails).toHaveLength(2);
    // fix the step (same place), repeat: the run finishes with the steps after it
    await t.api.patch(`/api/workflows/${wf.id}`, { steps: [tag('eins'), { id: 'kaputt', type: 'add_note', body: 'repariert' }, tag('drei')] });
    const done = await t.api.post(`/api/workflow-runs/${run.id}/retry`);
    expect(done.data.status).toBe('completed');
    expect(tagsOf(c.id)).toEqual(expect.arrayContaining(['eins', 'drei']));
    const after = readRun(t, wf.id, c.id);
    expect(after.log.filter((l: any) => l.type === 'retry')).toHaveLength(2);
    expect(after.log.filter((l: any) => l.type === 'add_tag' && l.result === 'eins')).toHaveLength(1);
    expect(t.app.db.all('SELECT id FROM notes WHERE contact_id = ? AND body = ?', c.id, 'repariert')).toHaveLength(1);
    // only a stopped run can be repeated
    expect((await t.api.post(`/api/workflow-runs/${run.id}/retry`)).status).toBe(400);
  });

  it('needs an active workflow and a run of this sub-account', async () => {
    const wf = await create('Pausiert wiederholen', [boom()], { stop_on_error: true });
    const c = await contactOf();
    const { run } = await enroll(wf, c.id);
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'paused' });
    const paused = await t.api.post(`/api/workflow-runs/${run.id}/retry`);
    expect(paused.status).toBe(400);
    expect(paused.data.error).toMatch(/nicht aktiv/);
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    expect((await t.api.post('/api/workflow-runs/gibtsnicht/retry')).status).toBe(404);
    const second = (await t.api.post('/api/locations', { name: 'Zweit 2' })).data.id;
    const foreign = await t.api.raw(`/api/workflow-runs/${run.id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pghl': '1', cookie: t.api.cookie, 'x-location-id': second }, body: '{}' });
    expect(foreign.status).toBe(404);
    expect(readRun(t, wf.id, c.id).run.status).toBe('failed');
  });

  it('repeats all stopped runs of a workflow at once', async () => {
    const wf = await create('Alle wiederholen', [boom({ id: 'b1' }), tag('ende')], { stop_on_error: true });
    const cs = [await contactOf(), await contactOf(), await contactOf()];
    for (const c of cs) await enroll(wf, c.id);
    expect(t.app.db.all(`SELECT id FROM workflow_runs WHERE workflow_id = ? AND status = 'failed'`, wf.id)).toHaveLength(3);
    const still = await t.api.post(`/api/workflows/${wf.id}/retry-failed`);
    expect(still.data).toEqual({ retried: 3, failed_again: 3, remaining: 3 });
    await t.api.patch(`/api/workflows/${wf.id}`, { steps: [{ id: 'b1', type: 'add_note', body: 'ok' }, tag('ende')] });
    const fixed = await t.api.post(`/api/workflows/${wf.id}/retry-failed`);
    expect(fixed.data).toEqual({ retried: 3, failed_again: 0, remaining: 0 });
    for (const c of cs) expect(tagsOf(c.id)).toContain('ende');
    expect((await t.api.post('/api/workflows/gibtsnicht/retry-failed')).status).toBe(404);
  });

  it('is part of the permission area "Automationen"', async () => {
    const { requiredPermission } = await import('../server/core/permissions.js');
    expect(requiredPermission('POST', '/api/workflow-runs/abc/retry')).toBe('workflows');
    expect(requiredPermission('POST', '/api/workflows/abc/retry-failed')).toBe('workflows');
  });
});

describe('the editor', () => {
  it('has the settings, the step option and the repeat buttons', () => {
    const ui = read('web/src/pages/WorkflowErrors.tsx');
    for (const needle of ['Bei Fehler: anderen Workflow starten', 'Fehler ignorieren und weiter', 'on_error_workflow_id', 'error_bell', 'error_email', 'retry']) expect(ui, needle).toContain(needle);
    const wf = read('web/src/pages/Workflows.tsx');
    expect(wf).toContain('<ErrorSettings');
    expect(wf).toContain('<ContinueOnError');
    expect(wf).toContain('<RetryButton');
  });
});
