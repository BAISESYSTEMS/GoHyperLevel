import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { blockedConnections, installOutboundGuard, uninstallOutboundGuard } from '../server/services/outbound-guard.js';
import { newApp, readRun, runWorkflow, type T } from './wfx-helpers.js';

/**
 * Sweeps over the whole library, driven by the catalogue (so a new step or trigger is covered the day it is added):
 *  - every trigger starts a workflow when its event arrives, with the sample data of its catalogue entry
 *  - every action, run for real with its own sample settings, ends in a result or a readable German error –
 *    never in a crash, a stack trace or a call to a service nobody mocked.
 * The targeted tests of the other wfx-*.test.ts files check what each step does; this file checks that none is left out.
 */

let t: T;
let loc = '';

beforeAll(async () => {
  t = await newApp();
  loc = t.api.location;
  // Whatever a step tries to reach outside this machine is refused at the socket (and recorded) – nothing leaves the box.
  installOutboundGuard();
});
afterAll(async () => {
  uninstallOutboundGuard();
  await t.close();
});
afterEach(() => {
  delete t.app.services.wfxNow;
});

/** The older steps with an editor of their own have no catalogue sample; these are the settings that editor would save. */
const LEGACY: Record<string, Record<string, unknown>> = {
  wait: { amount: 1, unit: 'hours' },
  send_email: { subject: 'Hallo {{contact.first_name}}', body: 'Schön, dass du da bist.' },
  send_sms: { body: 'Hallo {{contact.first_name}}' },
  add_tag: { tags: ['sweep'] },
  remove_tag: { tags: ['sweep'] },
  update_field: { field: 'city', value: 'Köln' },
  add_note: { body: 'Notiz vom Sweep' },
  create_task: { title: 'Nachfassen', due_in_days: 2 },
  notify: { subject: 'Hinweis', body: 'Text' },
  webhook: { url: 'https://example.com/hook', method: 'POST' },
  set_dnd: { value: true },
  review_request: { channel: 'email' },
};

/** Triggers that never come from an event on the bus: started by hand or through their own public URL. */
const NOT_EVENT_DRIVEN = new Set(['manual', 'webhook']);

describe('every trigger starts its workflow', () => {
  it('starts a workflow for the event of each trigger in the catalogue', async () => {
    const cat = (await t.api.get('/api/workflow-catalog')).data;
    const triggers = cat.triggers as { type: string; sample: Record<string, unknown> }[];
    const c = (await t.api.post('/api/contacts', { first_name: 'Erika', last_name: 'Muster', email: 'sweep@example.com' })).data;
    const started: Record<string, string> = {};
    for (const tr of triggers.filter((x) => !NOT_EVENT_DRIVEN.has(x.type))) {
      const wf = await t.api.post('/api/workflows', { name: `sweep ${tr.type}`, trigger: { type: tr.type, config: {} }, steps: [{ type: 'set_variable', rows: [{ name: 'ran', value: 'ja' }] }] });
      expect(wf.status, `${tr.type}: ${JSON.stringify(wf.data)}`).toBe(200);
      await t.api.patch(`/api/workflows/${wf.data.id}`, { status: 'active' });
      started[tr.type] = wf.data.id;
    }
    for (const tr of triggers.filter((x) => !NOT_EVENT_DRIVEN.has(x.type))) {
      const { contact: _sampleContact, ...sample } = (tr.sample ?? {}) as Record<string, unknown>;
      t.app.events.emit(loc, tr.type, { ...sample, contactId: c.id });
    }
    await t.app.events.flush();
    const missing: string[] = [];
    for (const [type, id] of Object.entries(started)) {
      const { run } = readRun(t, id, c.id);
      if (!run) missing.push(type);
      else expect(run.vars.ran, type).toBe('ja');
    }
    expect(missing, `Auslöser ohne Lauf: ${missing.join(', ')}`).toEqual([]);
    expect(Object.keys(started).length).toBeGreaterThanOrEqual(70);
  });

  it('a trigger only fires for its own event type', async () => {
    const c = (await t.api.post('/api/contacts', { first_name: 'Max', email: 'sweep-other@example.com' })).data;
    const wf = (await t.api.post('/api/workflows', { name: 'nur Kündigung', trigger: { type: 'product.subscription_ended', config: {} }, steps: [{ type: 'set_variable', rows: [{ name: 'ran', value: 'ja' }] }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    t.app.events.emit(loc, 'payment.failed', { contactId: c.id });
    await t.app.events.flush();
    expect(readRun(t, wf.id, c.id).run).toBeUndefined();
  });
});

describe('every action runs with its sample settings', () => {
  it('ends in a result or a readable German error, never in a crash or an unmocked call', async () => {
    const cat = (await t.api.get('/api/workflow-catalog')).data;
    const actions = cat.actions as { type: string; sample?: Record<string, unknown> }[];
    expect(actions.length).toBeGreaterThanOrEqual(100);
    const crashes: string[] = [];
    const ran: string[] = [];
    for (const a of actions) {
      let res;
      try {
        res = await runWorkflow(t, [{ id: 'sweep', type: a.type, ...(a.sample ?? LEGACY[a.type] ?? {}) }, { id: 'after', type: 'set_variable', rows: [{ name: 'after', value: 'ja' }] }]);
      } catch (e: any) {
        // the editor offers only samples the server accepts when the workflow is saved
        crashes.push(`${a.type}: Beispiel abgelehnt – ${e.message}`);
        continue;
      }
      ran.push(a.type);
      const entries = res.log.filter((l: any) => l.type === a.type);
      // a step that parks the run (waits) writes its entry when it resumes
      if (!entries.length && res.run.status !== 'waiting' && !['goto', 'goal_jump', 'goal', 'end', 'if', 'split_test', 'loop'].includes(a.type)) crashes.push(`${a.type}: kein Protokolleintrag`);
      for (const l of res.log) {
        const text = String(l.error ?? '');
        // Messages are for people: no JavaScript error names, no "undefined", no stack frames.
        if (text && /TypeError|ReferenceError|SyntaxError|RangeError|undefined|\[object |\bat \S+ \(|is not a function|Cannot read/.test(text)) crashes.push(`${a.type}: ${text}`);
      }
      expect(['completed', 'waiting', 'failed', 'stopped', 'active']).toContain(res.run.status);
    }
    expect(crashes).toEqual([]);
    expect(ran.length).toBe(actions.length);
    // The steps that call out tried; the guard refused every attempt (the webhook sample points at example.com).
    const hosts = blockedConnections().map((b) => b.host);
    expect(hosts).toContain('example.com');
    for (const host of hosts) expect(host, host).not.toMatch(/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/);
  }, 120_000);

  it('a step the library does not know fails with a clear message and stops the run', async () => {
    const r = await runWorkflow(t, [{ id: 'x', type: 'does_not_exist' }, { id: 'y', type: 'set_variable', rows: [{ name: 'after', value: 'ja' }] }]).catch((e) => e);
    // either the editor API refuses the workflow, or the run fails visibly – it never goes on silently
    if (r instanceof Error) expect(r.message).toMatch(/Unbekannt|unknown|Schritt/i);
    else {
      expect(r.run.status).toBe('failed');
      expect(r.vars.after).toBeUndefined();
    }
  });
});
