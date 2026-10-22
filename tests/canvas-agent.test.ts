import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { anthropicSse, events, fakeModel, sse } from './agent-fakes.js';
import { retry } from '../server/services/agent-llm.js';
import { toolCatalog } from '../server/services/agent-tools.js';

/** The HyperLevel Agent works on the Canvas through the ghl_canvas_* MCP tools (picked up from app.services.mcpTools). */

const AKEY = 'sk-ant-api03-canvasagent-abcdefghijklmnopqrstuvwxyz';
const model = fakeModel();
let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let board = '';

const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id, name, input });
const say = (text: string) => ({ type: 'text' as const, text });
const chat = async (message: string, ui?: Record<string, unknown>) => {
  const r = await t.api.post('/api/agent/chat', { message, ui });
  return { status: r.status, events: typeof r.data === 'string' ? events(r.data) : [] };
};

beforeAll(async () => {
  retry.ms = 1;
  t = await startTestApp();
  t.app.services.agentFetch = model.fetch;
  await t.setup();
  loc = t.api.location;
  expect((await t.api.post('/api/ai-connections', { provider: 'anthropic', api_key: AKEY, models: { text: 'claude-sonnet-5-5' } })).status).toBe(200);
  await t.api.put('/api/agent/settings', { default_mode: 'auto' });
  board = (await t.api.post('/api/canvas', { name: 'Agenten-Board' })).data.id;
  await t.api.post('/api/users', { email: 'nur-kontakte@example.com', name: 'Nora Nur-Kontakte', password: 'geheim123', role: 'member', locations: [loc], permissions: ['contacts'] });
}, 60_000);
afterAll(() => t.close());

describe('HyperLevel Agent on the canvas', () => {
  it('offers the canvas tools in their own group', () => {
    const user = { id: 'u', email: 'a@b.c', name: 'Chef', role: 'admin' as const, locations: [loc], permissions: null };
    const catalog = toolCatalog(t.app, user, { webFetch: false });
    const canvas = catalog.filter((x) => x.name.startsWith('ghl_canvas_'));
    expect(canvas.map((x) => x.name).sort()).toEqual(['ghl_canvas_add_elements', 'ghl_canvas_comment', 'ghl_canvas_create', 'ghl_canvas_delete_elements', 'ghl_canvas_export', 'ghl_canvas_from_mermaid', 'ghl_canvas_get', 'ghl_canvas_layout', 'ghl_canvas_list', 'ghl_canvas_update_elements']);
    expect(new Set(canvas.map((x) => x.group))).toEqual(new Set(['Canvas']));
    // reading is "read", drawing is "write", deleting asks first
    const klass = Object.fromEntries(canvas.map((x) => [x.name, x.klass]));
    expect(klass).toMatchObject({ ghl_canvas_get: 'read', ghl_canvas_list: 'read', ghl_canvas_add_elements: 'write', ghl_canvas_delete_elements: 'sensitive' });
  });

  it('draws on a board in the user’s name, with an agent cursor, and links to what it drew', async () => {
    model.reset();
    model.reply(
      sse(anthropicSse([say('Ich zeichne den Ablauf.'), tool('tu_1', 'ghl_canvas_add_elements', { board_id: board, elements: [{ ref: 'a', type: 'ellipse', text: 'Start' }, { ref: 'b', type: 'rect', text: 'Prüfen' }, { type: 'arrow', from: 'a', to: 'b', text: 'dann' }], layout: { kind: 'flow', direction: 'right' } })])),
      sse(anthropicSse([tool('tu_2', 'ghl_canvas_get', { board_id: board })])),
      sse(anthropicSse([say('Fertig: zwei Formen und ein Pfeil.')])),
    );
    const r = await chat('Zeichne einen kurzen Ablauf auf das Board', { route: `canvas/${board}`, label: 'Board: Agenten-Board', entity: { type: 'canvas', id: board, label: 'Agenten-Board' } });
    expect(r.status).toBe(200);
    expect(r.events.filter((e) => e.type === 'tool_result').map((e) => e.status)).toEqual(['ok', 'ok']);
    // the page the user looks at is passed along
    expect(JSON.stringify(model.calls[0].body.messages[0])).toContain('Seite: Board: Agenten-Board');
    // the result goes back to the model as data and carries a link to the board
    expect(JSON.stringify(model.calls[1].body)).toContain('/app/canvas/');
    const els = (await t.api.get(`/api/canvas/${board}`)).data;
    expect(els.elements.filter((e: any) => e.type !== 'arrow').map((e: any) => e.text)).toEqual(expect.arrayContaining(['Start', 'Prüfen']));
    expect(els.elements.find((e: any) => e.type === 'arrow')).toMatchObject({ text: 'dann' });
    // everyone watching sees a labelled agent cursor, named like the audit actor
    expect(els.viewers).toContainEqual(expect.objectContaining({ kind: 'agent', name: 'KI-Agent (im Auftrag von Chef)' }));
    const audit = (await t.api.get('/api/audit?limit=20')).data.find((a: any) => String(a.route).includes('/canvas/'));
    expect(audit).toMatchObject({ via: 'agent', actor: 'KI-Agent (im Auftrag von Chef)' });
    // the tool card offers a link to the board
    const card = r.events.find((e) => e.type === 'tool_result' && e.id === 'tu_1');
    expect(JSON.stringify(card)).toContain(`canvas/${board}`);
  });

  it('asks before deleting and respects "Nur lesen"', async () => {
    const els = (await t.api.get(`/api/canvas/${board}`)).data.elements as any[];
    const victim = els.find((e) => e.text === 'Start').id;
    model.reset();
    model.reply(sse(anthropicSse([tool('tu_d', 'ghl_canvas_delete_elements', { board_id: board, ids: [victim] })])), sse(anthropicSse([say('Ich warte auf deine Bestätigung.')])));
    const r = await chat('Lösche den Start');
    expect(r.events.some((e) => e.type === 'confirm' || e.type === 'tool_confirm' || (e.type === 'tool_result' && e.status !== 'ok'))).toBe(true);
    expect(((await t.api.get(`/api/canvas/${board}`)).data.elements as any[]).some((e) => e.id === victim)).toBe(true);
    await t.api.put('/api/agent/settings', { default_mode: 'read' });
    model.reset();
    model.reply(sse(anthropicSse([tool('tu_w', 'ghl_canvas_add_elements', { board_id: board, elements: [{ type: 'sticky', text: 'Nicht erlaubt' }] })])), sse(anthropicSse([say('Gesperrt.')])));
    const ro = await chat('Schreib eine Notiz');
    expect(ro.events.find((e) => e.type === 'tool_result')?.status).not.toBe('ok');
    expect(((await t.api.get(`/api/canvas/${board}`)).data.elements as any[]).some((e) => e.text === 'Nicht erlaubt')).toBe(false);
    await t.api.put('/api/agent/settings', { default_mode: 'auto' });
  });

  it('members without the canvas area cannot use the tools through the agent', async () => {
    t.api.clearCookie();
    expect((await t.api.post('/api/auth/login', { email: 'nur-kontakte@example.com', password: 'geheim123' })).status).toBe(200);
    model.reset();
    model.reply(sse(anthropicSse([tool('tu_m', 'ghl_canvas_get', { board_id: board })])), sse(anthropicSse([say('Kein Zugriff.')])));
    const r = await chat('Was steht auf dem Board?');
    expect(r.events.find((e) => e.type === 'tool_result' && e.id === 'tu_m')).toMatchObject({ status: 'error' });
    expect(JSON.stringify(model.calls[1].body)).not.toContain('Prüfen');
    t.api.clearCookie();
    expect((await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' })).status).toBe(200);
  });
});

describe('the open board as agent context', () => {
  it('resolves the board for the context chip and hands the outline to ui_context', async () => {
    const chip = await t.api.get(`/api/agent/context?route=canvas/${board}`);
    expect(chip.data).toMatchObject({ entity: { type: 'canvas', id: board, label: 'Agenten-Board' }, label: 'Board: Agenten-Board' });
    model.reset();
    model.reply(sse(anthropicSse([tool('tu_c', 'ui_context', {})])), sse(anthropicSse([say('Auf dem Board stehen Start und Prüfen.')])));
    const r = await chat('Was steht hier?', { route: `canvas/${board}`, label: 'Board: Agenten-Board', entity: { type: 'canvas', id: board, label: 'Agenten-Board' } });
    expect(r.events.find((e) => e.type === 'tool_result')?.status).toBe('ok');
    // the tool result (last message) has the outline, not the raw element list
    const seen = JSON.stringify(model.calls[1].body.messages.at(-1));
    expect(seen).toContain('Agenten-Board');
    expect(seen).toContain('Prüfen');
    expect(seen).not.toContain('seed');
  });
});
