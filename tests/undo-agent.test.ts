import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { anthropicSse, events, fakeModel, sse } from './agent-fakes.js';
import { startTestApp } from './helpers.js';
import { retry } from '../server/services/anthropic.js';

/** The HyperLevel Agent: what it changes is journaled as the agent, its tool card offers "Rückgängig", and it can take its own change back. */

const AKEY = 'sk-ant-api03-undoagent-abcdefghijklmnopqrstuvwxyz';
const model = fakeModel();
let t: Awaited<ReturnType<typeof startTestApp>>;
const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id, name, input });
const say = (text: string) => ({ type: 'text' as const, text });
const chat = async (message: string) => {
  const r = await t.api.post('/api/agent/chat', { message });
  return { status: r.status, events: typeof r.data === 'string' ? events(r.data) : [] };
};

beforeAll(async () => {
  retry.ms = 1;
  t = await startTestApp();
  t.app.services.agentFetch = model.fetch;
  await t.setup();
  expect((await t.api.post('/api/ai-connections', { provider: 'anthropic', api_key: AKEY, models: { text: 'claude-sonnet-5-5' } })).status).toBe(200);
  await t.api.put('/api/agent/settings', { default_mode: 'auto' });
});
afterAll(() => t.close());
beforeEach(() => model.reset());

describe('agent writes', () => {
  it('the tool card carries the journal entry, the entry names the agent, and the person can undo it', async () => {
    const task = (await t.api.post('/api/tasks', { title: 'Vom Agenten erledigt' })).data;
    model.reply(sse(anthropicSse([tool('tu_1', 'ghl_complete_task', { task_id: task.id })])), sse(anthropicSse([say('Erledigt.')])));
    const r = await chat('Hake die Aufgabe ab');
    const result = r.events.find((e) => e.type === 'tool_result');
    expect(result).toMatchObject({ status: 'ok' });
    expect(result.undo).toHaveLength(1);
    expect(result.undo[0].label).toBe('Aufgabe „Vom Agenten erledigt“ erledigt');
    expect(t.app.db.get<any>('SELECT done FROM tasks WHERE id = ?', task.id)!.done).toBe(1);
    // journaled as the agent, on behalf of the person
    const entry = t.app.db.get<any>('SELECT * FROM undo_entries WHERE id = ?', result.undo[0].id)!;
    expect(entry).toMatchObject({ actor_kind: 'agent', via: 'agent', actor: 'KI-Agent (im Auftrag von Chef)' });
    // it survives a reload of the conversation (the card shows "Rückgängig" again)
    const convs = (await t.api.get('/api/agent/conversations')).data;
    const conv = (await t.api.get(`/api/agent/conversations/${convs[0].id}`)).data;
    const card = conv.items.flatMap((i: any) => i.blocks ?? []).flatMap((b: any) => b.tools ?? []).find((x: any) => x.name === 'ghl_complete_task');
    expect(card.undo[0].id).toBe(result.undo[0].id);
    // Verlauf: the person sees it with the agent badge and takes it back
    const item = (await t.api.get('/api/undo')).data.items.find((i: any) => i.id === result.undo[0].id);
    expect(item).toMatchObject({ actor_kind: 'agent', mine: true, can_undo: true });
    expect((await t.api.post(`/api/undo/${result.undo[0].id}`, {})).status).toBe(200);
    expect(t.app.db.get<any>('SELECT done FROM tasks WHERE id = ?', task.id)!.done).toBe(0);
  });

  it('reads leave no card to undo; and the agent can roll back its own mistake with ghl_undo', async () => {
    const task = (await t.api.post('/api/tasks', { title: 'Irrtum' })).data;
    model.reply(sse(anthropicSse([tool('tu_a', 'ghl_complete_task', { task_id: task.id })])), sse(anthropicSse([say('Ups, falsche Aufgabe.')])));
    const first = await chat('Hake sie ab');
    const entryId = first.events.find((e) => e.type === 'tool_result').undo[0].id;
    model.reply(
      sse(anthropicSse([tool('tu_l', 'ghl_undo_list', { actor: 'agent', limit: 5 })])),
      sse(anthropicSse([tool('tu_u', 'ghl_undo', { entry_id: entryId })])),
      sse(anthropicSse([say('Zurückgenommen.')])),
    );
    const second = await chat('Mach das rückgängig');
    const results = second.events.filter((e) => e.type === 'tool_result');
    expect(results[0]).toMatchObject({ status: 'ok' });
    expect(results[0].undo).toBeUndefined();
    expect(results[0].preview).toContain(entryId);
    expect(results[1]).toMatchObject({ status: 'ok' });
    // the undo itself is journaled (and so offered as "Wiederholen"), the task is open again
    expect(results[1].undo?.length ?? 0).toBe(0);
    expect(t.app.db.get<any>('SELECT done FROM tasks WHERE id = ?', task.id)!.done).toBe(0);
    expect(t.app.db.get<any>("SELECT kind, actor_kind FROM undo_entries WHERE reverts_id = ?", entryId)).toMatchObject({ kind: 'undo', actor_kind: 'agent' });
  });
});
