import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { HttpError } from '../server/core/http.js';
import { fakeModel, json as jsonReply } from './agent-fakes.js';
import { catalogText, checkWorkflow, contextText, diffWorkflows, parseAnswer, reconcileIds, retryPrompt, usableActions, usableTriggers, type CheckEnv, type Refs } from '../server/services/wfai.js';

/** KI-Workflow-Builder: the AI is a script; what is under test is the catalogue check, the retries, the diff and the draft-only apply. */

let t: Awaited<ReturnType<typeof startTestApp>>;
let locA = '';
let locB = '';
let pipelineId = '';
let stageIds: string[] = [];
let env: CheckEnv;
const asked: any[] = [];
let script: (input: any, n: number) => string = () => '';
const net = fakeModel();
let realAiRun: any;

const wf = (over: Record<string, unknown> = {}) => ({
  name: 'Neue Anfrage nachfassen',
  summary: 'Setzt den Tag „lead“, begrüßt per E-Mail und fasst nach zwei Tagen nach.',
  trigger: { type: 'form.submitted', config: {} },
  steps: [
    { type: 'add_tag', tags: ['lead'] },
    { type: 'send_email', subject: 'Danke, {{contact.first_name|du}}!', body: 'Hallo {{contact.first_name|du}}, wir melden uns.' },
    { type: 'wait', amount: 2, unit: 'days' },
    { type: 'if', conditions: [{ field: 'tag', op: 'not_has', value: 'termin-gebucht' }], then: [{ type: 'send_sms', body: 'Magst du einen Termin buchen?' }], else: [] },
  ],
  settings: { allow_reentry: false, stop_on_error: false },
  notes: ['E-Mail-Absender unter Einstellungen → Kanäle prüfen'],
  ...over,
});

beforeAll(async () => {
  t = await startTestApp();
  t.app.services.aiConnectionsFetch = net.fetch;
  await t.setup();
  locA = t.api.location;
  locB = (await t.api.post('/api/locations', { name: 'Firma B' })).data.id;
  realAiRun = t.app.services.aiRun;
  t.app.services.aiRun = async (input: any) => {
    asked.push(input);
    return { text: script(input, asked.length), model: 'test-model', usage: { input_tokens: 100, output_tokens: 50 } };
  };
  const pipes = (await t.api.get('/api/pipelines')).data;
  pipelineId = pipes[0].id;
  stageIds = pipes[0].stages.map((s: any) => s.id);
  const cat = (await t.api.get('/api/workflow-catalog')).data;
  const refs: Refs = { pipeline: [{ id: pipelineId, name: pipes[0].name, stages: pipes[0].stages.map((s: any) => ({ id: s.id, name: s.name })) }], workflow: [{ id: 'w_other', name: 'Anderer', status: 'active' }], course: [{ id: 'k1', name: 'Kurs' }] };
  env = { actions: usableActions(cat.actions), triggers: usableTriggers(cat.triggers), refs };
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  asked.length = 0;
  net.reset();
});

describe('catalogue for the AI', () => {
  it('offers every described step and trigger, and no built-in step whose settings nobody described', () => {
    for (const type of ['send_email', 'wait', 'if', 'add_tag', 'goto', 'split_test', 'loop', 'dunning_send_link', 'certificate_issue', 'meta_buttons_send', 'invoice_dunning_send']) expect(env.actions.has(type), type).toBe(true);
    for (const type of ['agent_run', 'composio_action', 'plugin_action', 'mcp_tool']) expect(env.actions.has(type), type).toBe(false);
    for (const type of ['form.submitted', 'contact.tag_added', 'quiz.passed', 'dunning.started', 'payment_plan.completed', 'igcomment.matched', 'manual']) expect(env.triggers.has(type), type).toBe(true);
    expect(env.actions.size).toBeGreaterThan(90);
  });

  it('lists settings compactly with required marks, options and the ids it must not invent', () => {
    const text = catalogText(env.actions, env.triggers);
    expect(text).toContain('- send_email · E-Mail senden');
    expect(text).toMatch(/- wait · Warten.*amount\*:zahl\{wenn mode=delay\}/);
    expect(text).toMatch(/- create_opportunity · .*pipeline_id\*:<pipeline-id>, stage_id\*:<stage-id>/);
    expect(text).toMatch(/- form\.submitted · .*form_id:<form-id>/);
    expect(text).toContain('filters:[Bedingung]');
    // compact enough to send with every request
    expect(text.length).toBeLessThan(90_000);
  });

  it('describes the sub-account without secrets', () => {
    const c = contextText({ pipeline: env.refs.pipeline, workflow: env.refs.workflow, calendar: [], tags: ['lead', 'kunde'], custom_fields: [{ key: 'budget', label: 'Budget' }] }, { name: 'Testfirma', timezone: 'Europe/Berlin' });
    expect(c).toContain(`${pipelineId} = „`);
    expect(c).toContain('Kalender: keine vorhanden');
    expect(c).toContain('w_other = „Anderer“ (active)');
    expect(c).toContain('Vorhandene Tags: lead, kunde');
    expect(c).toContain('budget = Budget');
    expect(c).not.toContain('Formulare');
  });
});

describe('reading and checking the answer', () => {
  it('finds the JSON in fenced or chatty replies', () => {
    expect(parseAnswer('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseAnswer('Hier ist dein Workflow:\n{"a":{"b":2}}\nViel Erfolg!')).toEqual({ a: { b: 2 } });
    expect(parseAnswer('[1,2]')).toBeNull();
    expect(parseAnswer('keine Antwort')).toBeNull();
    expect(parseAnswer('')).toBeNull();
  });

  it('accepts a good workflow and keeps its structure', () => {
    const r = checkWorkflow(wf(), env);
    expect(r.errors).toEqual([]);
    expect(r.workflow!.trigger).toEqual({ type: 'form.submitted', config: {} });
    expect(r.workflow!.steps.map((s) => s.type)).toEqual(['add_tag', 'send_email', 'wait', 'if']);
    expect(r.workflow!.steps[3].then![0]).toMatchObject({ type: 'send_sms', body: 'Magst du einen Termin buchen?' });
    expect(r.workflow!.steps[3].else).toEqual([]);
    expect(r.workflow!.steps.every((s) => typeof s.id === 'string' && s.id.length >= 6)).toBe(true);
    expect(new Set(r.workflow!.steps.map((s) => s.id)).size).toBe(4);
    expect(r.notes).toEqual(['E-Mail-Absender unter Einstellungen → Kanäle prüfen']);
    expect(r.summary).toContain('lead');
  });

  it('names every problem so the AI can fix it', () => {
    const r = checkWorkflow(
      wf({
        trigger: { type: 'tag_added', config: {} },
        steps: [
          { type: 'schick_mail', subject: 'x' },
          { type: 'send_email', subject: 'Hallo' },
          { type: 'wait', amount: 0, unit: 'weeks' },
          { type: 'add_tag', tags: [] },
          { type: 'if', conditions: [{ field: 'tag', op: 'ist', value: 'x' }, { field: 'email' , op: 'equals' }], then: [{ type: 'form.submitted' }] },
          { type: 'create_opportunity', pipeline_id: 'erfunden', stage_id: 'auch-erfunden', name: 'x' },
          { type: 'goto', target: 'nirgends' },
        ],
      }),
      env,
    );
    expect(r.workflow).toBeUndefined();
    const all = r.errors.join('\n');
    expect(all).toContain('Auslöser „tag_added“ gibt es im Katalog nicht');
    expect(all).toContain('Schritt 1: Schritt-Typ „schick_mail“ gibt es im Katalog nicht');
    expect(all).toContain('Schritt 2 (E-Mail senden), „Text“ fehlt (Pflichtfeld)');
    expect(all).toMatch(/Schritt 3 \(Warten\).*„Menge“ muss mindestens 1 sein/);
    expect(all).toMatch(/Schritt 3 \(Warten\).*„weeks“ ist nicht erlaubt \(erlaubt: minutes, hours, days\)/);
    expect(all).toContain('Schritt 4 (Tag hinzufügen), „Tags“ fehlt (Pflichtfeld)');
    expect(all).toContain('Vergleich „ist“ gibt es nicht');
    expect(all).toContain('„value“ fehlt');
    expect(all).toContain('Schritt 5 › Dann › Schritt 1: Schritt-Typ „form.submitted“ gibt es im Katalog nicht (das sieht nach einem Auslöser aus)');
    expect(all).toContain('Pipelines (mit Stufen)-ID „erfunden“ gibt es in diesem Sub-Account nicht');
    expect(all).toContain('Sprungziel „nirgends“ ist kein Schritt dieses Workflows');
  });

  it('knows the sub-account: real ids pass, a stage must belong to its pipeline, an unknown id never does', () => {
    const ok = checkWorkflow(wf({ steps: [{ type: 'create_opportunity', pipeline_id: pipelineId, stage_id: stageIds[1], name: 'Lead', value: '{{event.amount}}' }] }), env);
    expect(ok.errors).toEqual([]);
    expect(ok.workflow!.steps[0]).toMatchObject({ pipeline_id: pipelineId, stage_id: stageIds[1], value: '{{event.amount}}' });
    const other: CheckEnv = { ...env, refs: { ...env.refs, pipeline: [...env.refs.pipeline!, { id: 'p2', name: 'Zweite', stages: [{ id: 's9', name: 'X' }] }] } };
    const wrong = checkWorkflow(wf({ steps: [{ type: 'create_opportunity', pipeline_id: 'p2', stage_id: stageIds[0] }] }), other);
    expect(wrong.errors.join()).toContain('gehört nicht zur Pipeline „Zweite“');
    expect(checkWorkflow(wf({ steps: [{ type: 'add_to_workflow', workflow_id: 'w_other' }] }), env).errors).toEqual([]);
    expect(checkWorkflow(wf({ steps: [{ type: 'add_to_workflow', workflow_id: 'w_fremd' }] }), env).errors.join()).toContain('„w_fremd“ gibt es in diesem Sub-Account nicht');
    expect(checkWorkflow(wf({ steps: [{ type: 'course_grant', course_id: 'k1' }] }), env).errors).toEqual([]);
    expect(checkWorkflow(wf({ steps: [{ type: 'course_grant', course_id: 'k2' }] }), env).errors.join()).toContain('„k2“');
  });

  it('turns an id that does not exist yet into a hint when the sub-account has none, and the step stays', () => {
    const none: CheckEnv = { ...env, refs: { ...env.refs, pipeline: [] } };
    const r = checkWorkflow(wf({ steps: [{ type: 'create_opportunity', name: 'Lead' }] }), none);
    expect(r.errors).toEqual([]);
    expect(r.warnings.join()).toContain('„Pipeline“ muss im Editor noch ausgewählt werden');
    expect(r.workflow!.steps[0].type).toBe('create_opportunity');
  });

  it('cleans values: types, select labels, tags, weekdays, unknown keys, wait modes', () => {
    const r = checkWorkflow(
      wf({
        steps: [
          { type: 'add_tag', tags: 'a, b, a' },
          { type: 'wait', amount: '3', unit: 'Tage', bogus: 1 },
          { type: 'wait', mode: 'weekday', days: ['MON', 'Fri'], time: '09:30' },
          { type: 'wait', mode: 'date', date: '24.12.2026' },
          { type: 'set_dnd', value: 'ja' },
          { type: 'review_request', channel: 'SMS' },
          { type: 'webhook', url: 'https://example.com/hook', method: 'GET', unknown_key: true },
        ],
      }),
      env,
    );
    expect(r.errors).toEqual([]);
    const [a, w1, w2, w3, d, rr, hook] = r.workflow!.steps;
    expect(a.tags).toEqual(['a', 'b']);
    expect(w1).toMatchObject({ amount: 3, unit: 'days' });
    expect(w1.bogus).toBeUndefined();
    expect(w2).toMatchObject({ mode: 'weekday', days: ['mon', 'fri'], time: '09:30' });
    expect(w3.date).toBe('24.12.2026');
    expect(d.value).toBe(true);
    expect(rr.channel).toBe('sms');
    expect(hook.unknown_key).toBeUndefined();
    expect(r.warnings.join()).toMatch(/bogus wird nicht verwendet/);
    // a wait by date without a date, a weekday step with a bad time
    const bad = checkWorkflow(wf({ steps: [{ type: 'wait', mode: 'date' }, { type: 'wait', mode: 'weekday', time: '25:99' }] }), env);
    expect(bad.errors.join()).toContain('„Datum“ fehlt');
    expect(bad.errors.join()).toContain('Uhrzeit als HH:MM');
  });

  it('handles containers and jumps: split test paths, loops, goto needs an existing id', () => {
    const r = checkWorkflow(
      wf({
        steps: [
          { id: 'start', type: 'add_tag', tags: ['x'] },
          { type: 'split_test', variants: [{ name: 'A', weight: 50 }, { name: 'B', weight: 50 }], b0: [{ type: 'send_sms', body: 'A' }], b1: [{ type: 'send_sms', body: 'B' }], b2: [{ type: 'send_sms', body: 'zuviel' }] },
          { type: 'loop', items: '{{var.items}}', each: [{ type: 'add_note', body: '{{var.item}}' }] },
          { type: 'goto', target: 'start', max_jumps: 2 },
        ],
      }),
      env,
    );
    expect(r.errors).toEqual([]);
    const [, split, loop, go] = r.workflow!.steps;
    expect(split.b0).toHaveLength(1);
    expect(split.b1).toHaveLength(1);
    expect(split.b2).toBeUndefined();
    expect(loop.each).toHaveLength(1);
    expect(go.target).toBe('start');
  });

  it('refuses too many steps, too deep nesting and an empty workflow', () => {
    const many = checkWorkflow(wf({ steps: Array.from({ length: 81 }, () => ({ type: 'add_tag', tags: ['x'] })) }), env);
    expect(many.errors.join()).toContain('Zu viele Schritte');
    let deep: any = { type: 'add_tag', tags: ['x'] };
    for (let i = 0; i < 8; i++) deep = { type: 'if', conditions: [{ field: 'tag', op: 'has', value: 'a' }], then: [deep] };
    expect(checkWorkflow(wf({ steps: [deep] }), env).errors.join()).toContain('zu tief verschachtelt');
    expect(checkWorkflow(wf({ steps: [] }), env).errors.join()).toContain('mindestens einen Schritt');
    expect(checkWorkflow(null, env).errors[0]).toContain('kein JSON-Objekt');
    expect(checkWorkflow(wf({ name: '' }), env).errors.join()).toContain('„name“ fehlt');
  });

  it('checks trigger configs, including the filters every trigger takes', () => {
    const ok = checkWorkflow(wf({ trigger: { type: 'contact.tag_added', config: { tag: 'lead', filters: [{ field: 'source', op: 'equals', value: 'Website' }], nonsense: 1 } } }), env);
    expect(ok.errors).toEqual([]);
    expect(ok.workflow!.trigger.config).toEqual({ tag: 'lead', filters: [{ field: 'source', op: 'equals', value: 'Website' }] });
    expect(ok.warnings.join()).toContain('nonsense');
    const bad = checkWorkflow(wf({ trigger: { type: 'appointment.status_changed', config: { status: 'maybe' } } }), env);
    expect(bad.errors.join()).toContain('„maybe“ ist nicht erlaubt');
    expect(checkWorkflow(wf({ trigger: { type: 'add_tag', config: {} } }), env).errors.join()).toContain('das ist ein Schritt, kein Auslöser');
  });

  it('puts the errors and the last draft into the retry prompt', () => {
    const p = retryPrompt('AUFTRAG: x', '{"kaputt"', ['Schritt 1: Typ fehlt', 'Zweiter Fehler']);
    expect(p).toContain('AUFTRAG: x');
    expect(p).toContain('{"kaputt"');
    expect(p).toContain('- Schritt 1: Typ fehlt\n- Zweiter Fehler');
  });
});

describe('diff', () => {
  const draft = (steps: any[], over: Record<string, unknown> = {}) => ({ name: 'W', trigger: { type: 'manual', config: {} }, steps, settings: { allow_reentry: false, stop_on_error: false }, ...over }) as any;
  const label = (x: string) => `<${x}>`;

  it('lists added, removed, changed and moved steps and what changed in them', () => {
    const before = draft([
      { id: 'a', type: 'add_tag', tags: ['x'] },
      { id: 'b', type: 'send_email', subject: 'Alt', body: 'Text' },
      { id: 'c', type: 'wait', amount: 1, unit: 'days' },
    ]);
    const after = draft(
      [
        { id: 'a', type: 'add_tag', tags: ['x'] },
        { id: 'b', type: 'send_email', subject: 'Neu', body: 'Text' },
        { id: 'n', type: 'send_sms', body: 'Neu' },
      ],
      { name: 'W2', trigger: { type: 'form.submitted', config: {} } },
    );
    const d = diffWorkflows(before, after, label);
    expect(d.steps.map((s) => `${s.id}:${s.status}`)).toEqual(['a:same', 'b:changed', 'n:added', 'c:removed']);
    expect(d.steps[1].changes).toEqual([{ key: 'subject', before: 'Alt', after: 'Neu' }]);
    expect(d.counts).toEqual({ added: 1, removed: 1, changed: 1, moved: 0, same: 1 });
    expect(d.name).toEqual({ changed: true, before: 'W', after: 'W2' });
    expect(d.trigger.changed).toBe(true);
    expect(d.steps[2].label).toBe('<send_sms>');
  });

  it('sees nested steps and a step that moved into a branch', () => {
    const before = draft([{ id: 'a', type: 'add_tag', tags: ['x'] }, { id: 'i', type: 'if', conditions: [], then: [], else: [] }]);
    const after = draft([{ id: 'i', type: 'if', conditions: [], then: [{ id: 'a', type: 'add_tag', tags: ['x'] }], else: [] }]);
    const d = diffWorkflows(before, after, label);
    expect(d.steps.find((s) => s.id === 'a')).toMatchObject({ status: 'moved', path: '0/then/0' });
    expect(d.steps.find((s) => s.id === 'i')!.status).toBe('moved');
  });

  it('treats a new workflow as all added', () => {
    const d = diffWorkflows(null, draft([{ id: 'a', type: 'add_tag', tags: ['x'] }]), label);
    expect(d.counts).toEqual({ added: 1, removed: 0, changed: 0, moved: 0, same: 0 });
    expect(d.name.changed).toBe(false);
  });

  it('gives steps without an id their old one back when type and place agree', () => {
    const before = [{ id: 'keep1', type: 'add_tag', tags: ['x'] }, { id: 'keep2', type: 'goto', target: 'keep1' }] as any[];
    const after = [{ id: 'zzz1', type: 'add_tag', tags: ['y'] }, { id: 'zzz2', type: 'goto', target: 'zzz1' }] as any[];
    reconcileIds(before, after);
    expect(after.map((s) => s.id)).toEqual(['keep1', 'keep2']);
    expect(after[1].target).toBe('keep1');
    const d = diffWorkflows(draft(before), draft(after), label);
    expect(d.counts).toMatchObject({ changed: 1, added: 0, removed: 0 });
  });
});

describe('generating through the API', () => {
  it('shows the preview, checks the answer and applies it only as a draft', async () => {
    script = () => JSON.stringify(wf());
    const before = (await t.api.get('/api/workflows')).data.length;
    const r = await t.api.post('/api/workflow-ai/generate', { prompt: 'Wenn jemand das Formular ausfüllt, Tag lead setzen, begrüßen und nach zwei Tagen nachfassen.' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ mode: 'create', attempts: 1, model: 'test-model', base: null });
    expect(r.data.workflow.steps).toHaveLength(4);
    expect(r.data.diff.counts).toMatchObject({ added: 5, removed: 0 }); // 4 steps + the nested SMS
    expect(r.data.notes).toHaveLength(1);
    // nothing exists yet
    expect((await t.api.get('/api/workflows')).data).toHaveLength(before);
    // what the AI saw: rules, catalogue, ids of this sub-account – no contact data
    const sys = asked[0].system.map((b: any) => b.text).join('\n');
    expect(asked[0].purpose).toBe('workflow_builder');
    expect(sys).toContain('- send_email · E-Mail senden');
    expect(sys).toContain(pipelineId);
    expect(asked[0].system[0].cache).toBe(true);
    expect(asked[0].user).toContain('AUFTRAG:\nWenn jemand das Formular');
    const ap = await t.api.post(`/api/workflow-ai/runs/${r.data.run_id}/apply`, {});
    expect(ap.status, JSON.stringify(ap.data)).toBe(200);
    expect(ap.data).toMatchObject({ ok: true, mode: 'create', status: 'draft' });
    const created = (await t.api.get(`/api/workflows/${ap.data.workflow_id}`)).data;
    expect(created).toMatchObject({ name: 'Neue Anfrage nachfassen', status: 'draft' });
    expect(created.trigger.type).toBe('form.submitted');
    expect(created.steps.map((s: any) => s.type)).toEqual(['add_tag', 'send_email', 'wait', 'if']);
    // never active, never run
    expect(t.app.db.get<any>('SELECT COUNT(*) AS n FROM workflow_runs WHERE workflow_id = ?', created.id).n).toBe(0);
    // applied once
    expect((await t.api.post(`/api/workflow-ai/runs/${r.data.run_id}/apply`, {})).status).toBe(409);
    const runs = (await t.api.get('/api/workflow-ai/runs')).data;
    expect(runs[0]).toMatchObject({ id: r.data.run_id, status: 'applied', applied_workflow_id: created.id, attempts: 1 });
    expect(t.app.db.get<any>(`SELECT 1 AS x FROM audit_log WHERE location_id = ? AND action = 'workflow_ai.apply'`, locA)).toBeTruthy();
    expect((await t.api.get(`/api/workflow-ai/runs/${r.data.run_id}`)).data.workflow.name).toBe('Neue Anfrage nachfassen');
  });

  it('sends the errors back and succeeds on the second try', async () => {
    script = (_i, n) => (n === 1 ? JSON.stringify(wf({ steps: [{ type: 'send_whatsapp_nachricht', body: 'x' }] })) : `Gern, hier ist der korrigierte Workflow:\n\`\`\`json\n${JSON.stringify(wf({ name: 'Zweiter Versuch' }))}\n\`\`\``);
    const r = await t.api.post('/api/workflow-ai/generate', { prompt: 'Schicke eine WhatsApp-Nachricht an neue Leads.' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ attempts: 2 });
    expect(r.data.workflow.name).toBe('Zweiter Versuch');
    expect(asked).toHaveLength(2);
    expect(asked[1].user).toContain('DEIN LETZTER ENTWURF WAR NICHT GÜLTIG');
    expect(asked[1].user).toContain('Schritt-Typ „send_whatsapp_nachricht“ gibt es im Katalog nicht');
    expect(asked[1].user).toContain('send_whatsapp_nachricht');
    // the same static block is sent again (cached by the provider)
    expect(asked[1].system[0].text).toBe(asked[0].system[0].text);
  });

  it('retries a reply that is not JSON and gives up after three attempts, naming what was wrong', async () => {
    script = () => 'Das kann ich leider nicht.';
    const r = await t.api.post('/api/workflow-ai/generate', { prompt: 'Mach etwas Tolles mit Kontakten bitte.' });
    expect(r.status).toBe(422);
    expect(r.data.error).toContain('nach 3 Versuchen');
    expect(r.data.error).toContain('kein einzelnes JSON-Objekt');
    expect(asked).toHaveLength(3);
    const row = t.app.db.get<any>(`SELECT * FROM wfai_runs WHERE location_id = ? AND status = 'failed' ORDER BY created_at DESC LIMIT 1`, locA);
    expect(row).toMatchObject({ attempts: 3, tokens: 450 });
    expect((await t.api.post(`/api/workflow-ai/runs/${row.id}/apply`, {})).status).toBe(409);
  });

  it('asks again when the answer invents an id', async () => {
    script = (_i, n) => JSON.stringify(wf({ steps: [{ type: 'create_opportunity', pipeline_id: n === 1 ? 'pipeline-erfunden' : pipelineId, stage_id: stageIds[0], name: 'Lead' }] }));
    const r = await t.api.post('/api/workflow-ai/generate', { prompt: 'Lege für neue Leads eine Opportunity an.' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.attempts).toBe(2);
    expect(asked[1].user).toContain('„pipeline-erfunden“ gibt es in diesem Sub-Account nicht');
    expect(r.data.workflow.steps[0].pipeline_id).toBe(pipelineId);
  });

  it('passes the limits of the AI on without retrying (no key, budget)', async () => {
    let calls = 0;
    t.app.services.aiRun = async () => {
      calls++;
      throw new HttpError(409, 'Kein Anthropic-API-Schlüssel hinterlegt (Einstellungen → KI-Assistent).');
    };
    const r = await t.api.post('/api/workflow-ai/generate', { prompt: 'Irgendein Workflow bitte.' });
    expect(r.status).toBe(409);
    expect(r.data.error).toContain('API-Schlüssel');
    expect(calls).toBe(1);
    t.app.services.aiRun = async (input: any) => {
      asked.push(input);
      return { text: script(input, asked.length), model: 'test-model', usage: { input_tokens: 100, output_tokens: 50 } };
    };
  });

  it('validates the request', async () => {
    expect((await t.api.post('/api/workflow-ai/generate', { prompt: 'x' })).status).toBe(400);
    expect((await t.api.post('/api/workflow-ai/generate', {})).status).toBe(400);
    expect((await t.api.post('/api/workflow-ai/generate', { prompt: 'Ändere diesen Workflow bitte.', workflow_id: 'gibt-es-nicht' })).status).toBe(404);
    expect((await t.api.get('/api/workflow-ai/runs/unbekannt')).status).toBe(404);
    expect((await t.api.post('/api/workflow-ai/runs/unbekannt/apply', {})).status).toBe(404);
  });
});

describe('changing a workflow', () => {
  let wid = '';
  let ids: string[] = [];
  it('keeps the ids, shows what changes, and saves it as the workflow’s draft without publishing', async () => {
    const created = (await t.api.post('/api/workflows', { name: 'Willkommen', trigger: { type: 'form.submitted', config: {} }, steps: [{ type: 'add_tag', tags: ['lead'] }, { type: 'send_email', subject: 'Hallo', body: 'Willkommen' }] })).data;
    wid = created.id;
    ids = created.steps.map((s: any) => s.id);
    await t.api.patch(`/api/workflows/${wid}`, { status: 'active' });
    const versionsBefore = t.app.db.get<any>('SELECT COUNT(*) AS n FROM workflow_versions WHERE workflow_id = ?', wid).n;
    script = () =>
      JSON.stringify(
        wf({
          name: 'Willkommen',
          summary: 'Die Mail heißt jetzt anders; nach einem Tag folgt eine SMS.',
          steps: [
            { id: ids[0], type: 'add_tag', tags: ['lead'] },
            { id: ids[1], type: 'send_email', subject: 'Schön, dass du da bist', body: 'Willkommen' },
            { type: 'wait', amount: 1, unit: 'days' },
            { type: 'send_sms', body: 'Alles klar bei dir?' },
          ],
        }),
      );
    const r = await t.api.post('/api/workflow-ai/generate', { prompt: 'Ändere die Betreffzeile und schicke nach einem Tag eine SMS.', workflow_id: wid });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ mode: 'edit', base: { id: wid, status: 'active', has_draft: false } });
    expect(asked[0].user).toContain('BISHERIGER WORKFLOW (JSON)');
    expect(asked[0].user).toContain(ids[1]);
    expect(asked[0].system[0].text).toContain('ÄNDERN:');
    expect(r.data.diff.counts).toEqual({ added: 2, removed: 0, changed: 1, moved: 0, same: 1 });
    expect(r.data.diff.steps.find((s: any) => s.id === ids[1]).changes).toEqual([{ key: 'subject', before: 'Hallo', after: 'Schön, dass du da bist' }]);
    const ap = await t.api.post(`/api/workflow-ai/runs/${r.data.run_id}/apply`, {});
    expect(ap.status, JSON.stringify(ap.data)).toBe(200);
    expect(ap.data).toMatchObject({ mode: 'edit', workflow_id: wid, replaced_draft: false });
    // the saved workflow is untouched and still active; the change waits as a draft
    const live = (await t.api.get(`/api/workflows/${wid}`)).data;
    expect(live.status).toBe('active');
    expect(live.steps).toHaveLength(2);
    expect(live.steps[1].subject).toBe('Hallo');
    const draft = (await t.api.get(`/api/workflows/${wid}/draft`)).data.draft;
    expect(draft.steps).toHaveLength(4);
    expect(draft.steps[1].subject).toBe('Schön, dass du da bist');
    expect(t.app.db.get<any>('SELECT COUNT(*) AS n FROM workflow_versions WHERE workflow_id = ?', wid).n).toBe(versionsBefore);
  });

  it('builds on the existing draft, and says when it replaces one', async () => {
    script = () =>
      JSON.stringify(
        wf({
          steps: [
            { id: ids[0], type: 'add_tag', tags: ['lead', 'neu'] },
            { id: ids[1], type: 'send_email', subject: 'Schön, dass du da bist', body: 'Willkommen' },
            { type: 'wait', amount: 1, unit: 'days' },
            { type: 'send_sms', body: 'Alles klar bei dir?' },
          ],
        }),
      );
    const r = await t.api.post('/api/workflow-ai/generate', { prompt: 'Füge dem ersten Tag noch „neu“ hinzu.', workflow_id: wid });
    expect(r.data.base).toMatchObject({ has_draft: true });
    // the AI got the draft (4 steps), not the saved workflow
    expect(asked[0].user).toContain('Schön, dass du da bist');
    const ap = await t.api.post(`/api/workflow-ai/runs/${r.data.run_id}/apply`, {});
    expect(ap.data.replaced_draft).toBe(true);
    expect((await t.api.get(`/api/workflows/${wid}`)).data.status).toBe('active');
  });

  it('lists the runs of one workflow', async () => {
    const runs = (await t.api.get(`/api/workflow-ai/runs?workflow_id=${wid}`)).data;
    expect(runs.length).toBe(2);
    expect(runs.every((x: any) => x.workflow_id === wid && x.mode === 'edit')).toBe(true);
  });
});

describe('MCP, permissions and isolation', () => {
  const mcp = async (name: string, args: any, key: string) => {
    const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const j: any = await r.json();
    const text = j.result?.content?.[0]?.text ?? '';
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* error text */
    }
    return { isError: !!j.result?.isError, text, data };
  };

  it('ghl_workflow_generate previews, and only applies as a draft when asked', async () => {
    script = () => JSON.stringify(wf({ name: 'Per MCP' }));
    const key = (await t.api.post('/api/api-keys', { name: 'WF-KI' })).data.key;
    const count = () => t.app.db.get<any>(`SELECT COUNT(*) AS n FROM workflows WHERE location_id = ?`, locA).n;
    const before = count();
    const prev = await mcp('ghl_workflow_generate', { location_id: locA, prompt: 'Baue einen Nachfass-Workflow für neue Anfragen.' }, key);
    expect(prev.isError, prev.text).toBe(false);
    expect(prev.data).toMatchObject({ name: 'Per MCP', applied: null, changes: { added: 5 } });
    expect(prev.data.hint).toContain('Vorschau');
    expect(count()).toBe(before);
    const done = await mcp('ghl_workflow_generate', { location_id: locA, prompt: 'Baue einen Nachfass-Workflow für neue Anfragen.', apply: true }, key);
    expect(done.data.applied).toMatchObject({ ok: true, status: 'draft' });
    expect(done.data.hint).toContain('nicht veröffentlicht');
    expect(count()).toBe(before + 1);
    expect(t.app.db.get<any>(`SELECT status FROM workflows WHERE id = ?`, done.data.applied.workflow_id).status).toBe('draft');
    const tools = (await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) }).then((r) => r.json())) as any;
    expect(tools.result.tools.map((x: any) => x.name)).toContain('ghl_workflow_generate');
  });

  it('is part of the workflows area', async () => {
    const { requiredPermission } = await import('../server/core/permissions.js');
    expect(requiredPermission('POST', '/api/workflow-ai/generate')).toBe('workflows');
    expect(requiredPermission('GET', '/api/workflow-ai/runs')).toBe('workflows');
  });

  it('keeps sub-accounts apart: no runs, no workflows, no ids of another sub-account', async () => {
    const runA = (await t.api.get('/api/workflow-ai/runs')).data[0];
    await t.api.post('/api/users', { email: 'b@example.com', name: 'Bernd', password: 'geheim123', role: 'member', locations: [locB], permissions: ['workflows'] });
    await t.api.post('/api/users', { email: 'ohne@example.com', name: 'Ohne', password: 'geheim123', role: 'member', locations: [locA], permissions: ['contacts'] });
    t.api.clearCookie();
    expect((await t.api.post('/api/auth/login', { email: 'ohne@example.com', password: 'geheim123' })).status).toBe(200);
    t.api.setLocation(locA);
    expect((await t.api.post('/api/workflow-ai/generate', { prompt: 'Ein Workflow ohne Recht bitte.' })).status).toBe(403);
    t.api.clearCookie();
    expect((await t.api.post('/api/auth/login', { email: 'b@example.com', password: 'geheim123' })).status).toBe(200);
    t.api.setLocation(locB);
    expect((await t.api.get('/api/workflow-ai/runs')).data).toEqual([]);
    expect((await t.api.get(`/api/workflow-ai/runs/${runA.id}`)).status).toBe(404);
    expect((await t.api.post(`/api/workflow-ai/runs/${runA.id}/apply`, {})).status).toBe(404);
    const wA = t.app.db.get<any>(`SELECT id FROM workflows WHERE location_id = ? LIMIT 1`, locA).id;
    expect((await t.api.post('/api/workflow-ai/generate', { prompt: 'Ändere den Workflow der anderen Firma.', workflow_id: wA })).status).toBe(404);
    // the AI of B learns nothing about A
    script = () => JSON.stringify(wf());
    asked.length = 0;
    const r = await t.api.post('/api/workflow-ai/generate', { prompt: 'Ein einfacher Workflow für Firma B bitte.' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const seen = asked[0].system.map((b: any) => b.text).join('\n') + asked[0].user;
    expect(seen).not.toContain(pipelineId);
    expect(seen).not.toContain(wA);
    expect(seen).not.toContain('Willkommen');
    t.api.clearCookie();
    await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' });
    t.api.setLocation(locA);
  });

  it('reports whether the AI is ready and which provider serves it', async () => {
    const s = (await t.api.get('/api/workflow-ai/status')).data;
    expect(s.examples.length).toBeGreaterThanOrEqual(3);
    expect(s.limits).toMatchObject({ per_hour: 20, attempts: 3 });
    expect(typeof s.ready).toBe('boolean');
    expect(s.provider).toMatchObject({ byok: false });
  });
});

describe('BYOK routing under the use "Workflows"', () => {
  it('routes the builder to its own connection, falls back to the quick-text connection, and leaves other texts alone', async () => {
    t.app.services.aiRun = realAiRun;
    t.api.setLocation(locA);
    const usages = (await t.api.get('/api/ai-connections/presets')).data.usages;
    expect(usages.find((u: any) => u.id === 'workflows')).toMatchObject({ label: expect.stringContaining('Workflow'), capability: 'text' });
    const quick = (await t.api.post('/api/ai-connections', { provider: 'together', label: 'Schnell', api_key: 'together-quick-key', models: { text: 'Qwen/Qwen2.5-72B-Instruct-Turbo' } })).data;
    const builder = (await t.api.post('/api/ai-connections', { provider: 'openrouter', label: 'Builder', api_key: 'sk-or-v1-builder-key-abcdef123456', models: { text: 'anthropic/claude-opus-5.5' } })).data;
    const reply = (text: string) =>
      jsonReply({ id: 'r', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 3000, completion_tokens: 400 } });

    // only "text" routed → the builder uses it
    await t.api.put('/api/ai-connections/routing', { usage: 'text', connection_id: quick.id });
    expect((await t.api.put('/api/ai/settings', { enabled: true })).status).toBe(200);
    net.reply(reply(JSON.stringify(wf({ name: 'Über Schnell-Verbindung' }))));
    let r = await t.api.post('/api/workflow-ai/generate', { prompt: 'Ein Workflow über die Schnell-Verbindung bitte.' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(net.calls[0].url).toBe('https://api.together.xyz/v1/chat/completions');
    expect(net.calls[0].headers.authorization).toBe('Bearer together-quick-key');
    expect(net.calls[0].body.messages[0].content).toContain('KATALOG');
    expect((await t.api.get('/api/workflow-ai/status')).data.provider).toMatchObject({ label: 'Schnell', byok: true });
    net.reset();

    // "workflows" routed → the builder uses it, quick texts still use "text"
    await t.api.put('/api/ai-connections/routing', { usage: 'workflows', connection_id: builder.id });
    net.reply(reply(JSON.stringify(wf({ name: 'Über Builder-Verbindung' }))));
    r = await t.api.post('/api/workflow-ai/generate', { prompt: 'Ein Workflow über die Builder-Verbindung bitte.' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.workflow.name).toBe('Über Builder-Verbindung');
    expect(net.calls[0].url).toContain('openrouter.ai');
    expect(net.calls[0].body.model).toBe('anthropic/claude-opus-5.5');
    expect((await t.api.get('/api/ai/provider')).data.routed).toMatchObject({ label: 'Schnell' });
    expect((await t.api.get('/api/workflow-ai/status')).data.provider).toMatchObject({ label: 'Builder', byok: true });
    // the usage log names the purpose
    const usage = (await t.api.get('/api/ai/usage')).data;
    expect(usage.purposes.workflow_builder).toBe('KI-Workflow-Builder');
    expect(usage.recent[0]).toMatchObject({ purpose: 'workflow_builder', status: 'ok' });
    // a retry goes through the same connection
    net.reset();
    net.reply(reply('{"name": "kaputt"}'), reply(JSON.stringify(wf({ name: 'Nach Korrektur' }))));
    r = await t.api.post('/api/workflow-ai/generate', { prompt: 'Noch ein Workflow über die Builder-Verbindung.' });
    expect(r.data).toMatchObject({ attempts: 2 });
    expect(net.calls).toHaveLength(2);
    expect(net.calls[1].body.messages.at(-1).content).toContain('DEIN LETZTER ENTWURF');
    // removing the routing falls back again
    await t.api.put('/api/ai-connections/routing', { usage: 'workflows', connection_id: '' });
    expect((await t.api.get('/api/workflow-ai/status')).data.provider).toMatchObject({ label: 'Schnell' });
  });
});
