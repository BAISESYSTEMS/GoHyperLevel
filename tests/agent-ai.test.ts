import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { retry } from '../server/services/anthropic.js';
import { checkAgent, type CatalogTool } from '../server/services/agent-ai.js';

/** "KI-Agent mit KI erstellen": the model is a script behind the Claude API; under test are the checks against the custom-agent schema and the tool catalogue, the retry, and the draft-only save. */

const KEY = 'sk-ant-api03-testkey-abcdefghijklmnopqrstuvwxyz0123';
const calls: any[] = [];
let queue: string[] = [];
const fake = (async (_url: string, init: any = {}) => {
  calls.push(JSON.parse(init.body));
  const text = queue.shift() ?? '{}';
  return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 3000, output_tokens: 800 } }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as unknown as typeof fetch;

const AGENT = {
  name: 'Montags-Bericht',
  emoji: '📊',
  description: 'Fasst jeden Montag offene Deals und überfällige Aufgaben zusammen.',
  instructions: 'Du erstellst jeden Montag einen kurzen Bericht: offene Deals nach Phase, überfällige Aufgaben mit Verantwortlichen. Du änderst nichts.',
  model: '',
  tools: ['ghl_list_opportunities', 'ghl_list_tasks', 'ghl_dashboard'],
  knowledge: { sources: ['agent', 'project'], text: '' },
  mode: 'read',
  max_steps: 8,
  starters: ['Wie sieht die Pipeline aus?'],
  schedule: { cadence: 'weekly', weekday: 0, day: 1, time: '08:00', prompt: 'Erstelle den Montags-Bericht.', deliver: 'email' },
  summary: 'Ein lesender Berichts-Agent mit Zeitplan.',
  notes: ['E-Mail-Versand unter Einstellungen prüfen'],
};

let t: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  retry.ms = 1;
  t = await startTestApp();
  t.app.services.aiFetch = fake;
  await t.setup();
}, 60_000);
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  calls.length = 0;
  queue = [];
});

describe('the check', () => {
  const catalog = new Map<string, CatalogTool>([
    ['ghl_list_tasks', { name: 'ghl_list_tasks', title: 'Aufgaben', group: 'Aufgaben', klass: 'read' }],
    ['ghl_create_task', { name: 'ghl_create_task', title: 'Aufgabe anlegen', group: 'Aufgaben', klass: 'write' }],
  ]);
  it('accepts a valid config and names every problem of a broken one', () => {
    expect(checkAgent({ ...AGENT, tools: ['ghl_list_tasks'] }, catalog).errors).toEqual([]);
    const bad = checkAgent({ ...AGENT, name: '', tools: ['ghl_erfunden'], mode: 'yolo', max_steps: 99, knowledge: { sources: ['internet'] }, schedule: { cadence: 'hourly', time: '25:00', prompt: '' } }, catalog).errors.join('\n');
    for (const s of ['„name“ fehlt', 'Unbekannte Werkzeuge: ghl_erfunden', '„mode“', '„max_steps“', 'Wissensquellen: internet', 'schedule.cadence', 'schedule.time', 'schedule.prompt']) expect(bad).toContain(s);
    expect(checkAgent({ ...AGENT, tools: ['ghl_create_task'] }, catalog).warnings[0]).toContain('nur lesen');
  });
});

describe('generate → review → draft agent', () => {
  it('generates with the real tool catalogue, retries an invented tool, and saves a private draft with the schedule off', async () => {
    expect((await t.api.post('/api/agent-ai/generate', { prompt: 'Jeden Montag ein Bericht über offene Deals.' })).status).toBe(409);
    await t.api.put('/api/ai/settings', { api_key: KEY, enabled: true });
    expect((await t.api.get('/api/agent-ai/status')).data).toMatchObject({ ready: true, provider: { label: 'Claude' } });
    queue = [JSON.stringify({ ...AGENT, tools: [...AGENT.tools, 'ghl_zauberstab'] }), JSON.stringify(AGENT)];
    const r = await t.api.post('/api/agent-ai/generate', { prompt: 'Jeden Montag um 8 Uhr ein Bericht über offene Deals und überfällige Aufgaben per E-Mail.' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ attempts: 2, config: { name: 'Montags-Bericht', mode: 'read', max_steps: 8, schedule: { cadence: 'weekly', time: '08:00' } } });
    expect(r.data.tools.map((x: any) => x.name)).toEqual(AGENT.tools);
    expect(calls[0].system[0].text).toContain('ghl_list_opportunities · ');
    expect(calls[1].messages[0].content).toContain('Unbekannte Werkzeuge: ghl_zauberstab');
    expect((await t.api.get('/api/agents')).data).toHaveLength(0);
    const saved = await t.api.post(`/api/agent-ai/runs/${r.data.run_id}/apply`, {});
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);
    expect(saved.data).toMatchObject({ draft: true, name: 'Montags-Bericht', visibility: 'private', tools: AGENT.tools, mode: 'read', responder: { enabled: false } });
    expect(saved.data.schedules[0]).toMatchObject({ enabled: false, cadence: 'weekly', deliver: 'email' });
    expect((await t.api.post(`/api/agent-ai/runs/${r.data.run_id}/apply`, {})).status).toBe(409);
    expect((await t.api.get('/api/ai/usage')).data.purposes.agent_builder).toBe('KI-Agent mit KI erstellen');
  });

  it('the HyperLevel Agent drafts through ghl_agent_generate, but saving an agent stays with the person', async () => {
    const me = (await t.api.get('/api/me')).data.user;
    queue = [JSON.stringify({ ...AGENT, name: 'Lead-Prüfer', schedule: null, mode: 'ask', tools: ['ghl_search_contacts', 'ghl_create_task'] })];
    const tool = t.app.services.mcpTools.find((x: any) => x.name === 'ghl_agent_generate');
    expect(tool.inputSchema.required).toEqual(['location_id', 'prompt']);
    expect(tool.klassFor({})).toBe('write');
    const out: any = await t.app.services.agent.runTool({ user: me, locationId: t.api.location, name: 'ghl_agent_generate', args: { prompt: 'Ein Agent, der neue Leads prüft und Aufgaben anlegt.' }, allow: 'write' });
    expect(out).toMatchObject({ config: { name: 'Lead-Prüfer', mode: 'ask' }, applied: null });
    // the agent never changes agent configurations (agent-safety AGENT_FORBIDDEN) – the person saves the draft
    queue = [JSON.stringify({ ...AGENT, name: 'Lead-Prüfer', schedule: null })];
    await expect(t.app.services.agent.runTool({ user: me, locationId: t.api.location, name: 'ghl_agent_generate', args: { prompt: 'Ein Agent, der neue Leads prüft und Aufgaben anlegt.', apply: true }, allow: 'write' })).rejects.toThrow(/Das darf der KI-Agent nicht/);
    expect((await t.api.get('/api/agents')).data.map((a: any) => a.name)).not.toContain('Lead-Prüfer');
    const run = t.app.db.get<{ id: string }>(`SELECT id FROM agent_ai_runs WHERE status = 'ok' ORDER BY created_at DESC LIMIT 1`)!;
    expect((await t.api.post(`/api/agent-ai/runs/${run.id}/apply`, {})).data).toMatchObject({ name: 'Lead-Prüfer', draft: true });
  });
});
