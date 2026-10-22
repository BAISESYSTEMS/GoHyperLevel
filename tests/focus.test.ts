import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { client, type Call } from './security-fixtures.js';
import { strictCompatible } from '../server/services/openai.js';
import { FOCUS_TOOLS } from '../server/modules/focus.js';
import { classify, routeProblem } from '../server/services/agent-safety.js';
import { focusSchema, focusTypes, noInventedNumbers, parseFocusAnswer, validateTiles } from '../server/services/focus-compose.js';
import { planRules } from '../server/services/focus-rules.js';
import { WidgetRegistry } from '../server/services/boards-widgets.js';
import { registerCoreWidgets } from '../server/services/boards-widgets-core.js';

/**
 * Fokus-Modus: question → ephemeral view of board widgets. The model is faked; the rules, the validation against the widget
 * catalogue, the reading with the caller's rights and sub-account, the limits and the MCP tool are real.
 */

const types = (plan: { tiles: { type: string; config: Record<string, unknown> }[] }) => plan.tiles.map((x) => (x.type === 'kpi' || x.type === 'chart' ? `${x.type}:${x.config.preset}` : x.type === 'list' ? `list:${x.config.entity}` : x.type));

describe('rules without AI: each intent → its widgets', () => {
  it('maps the suggestion chips (German)', () => {
    expect(types(planRules('Offene Deals'))).toEqual(['kpi:open_pipeline_value', 'kpi:open_deals', 'list:deals', 'pipeline']);
    const revenue = planRules('Umsatz diesen Monat');
    expect(types(revenue)).toEqual(['kpi:paid_revenue', 'kpi:won_revenue', 'kpi:open_invoices', 'chart:revenue_by_month']);
    expect(revenue.tiles[0].config.range).toBe('this_month');
    expect(revenue.say).toContain('diesen Monat');
    const overdue = planRules('Was ist überfällig?');
    expect(types(overdue)).toEqual(['kpi:overdue_tasks', 'kpi:overdue_invoices', 'tasks', 'list:deals']);
    expect(overdue.tiles.find((x) => x.type === 'tasks')!.config.due).toBe('overdue');
    expect(overdue.action).toBeNull();
    const today = planRules('Termine heute');
    expect(types(today)).toEqual(['kpi:appointments', 'agenda']);
    expect(today.tiles[1].config.days).toBe(1);
    const contacts = planRules('Neue Kontakte diese Woche');
    expect(types(contacts)).toEqual(['kpi:new_contacts', 'list:contacts', 'chart:leads_by_source']);
    expect(contacts.tiles[0].config.range).toBe('this_week');
    expect(types(planRules('Ungelesene Nachrichten'))).toEqual(['kpi:unread_conversations', 'inbox']);
    expect(planRules('Ungelesene Nachrichten').tiles[1].config.only_unread).toBe(true);
    expect(types(planRules('Offene Tickets'))).toEqual(['kpi:tickets_open', 'list:tickets']);
    expect(types(planRules('Meine Aufgaben heute'))).toEqual(['kpi:open_tasks', 'kpi:overdue_tasks', 'tasks']);
  });

  it('understands English and answers in the language asked for', () => {
    expect(types(planRules('open deals', 'en'))).toEqual(['kpi:open_pipeline_value', 'kpi:open_deals', 'list:deals', 'pipeline']);
    expect(planRules('open deals', 'en').tiles[0].title).toBe('Open pipeline value');
    expect(planRules('revenue this month', 'en').say).toBe('This is your revenue this month.');
    expect(types(planRules("what's overdue?", 'en'))[0]).toBe('kpi:overdue_tasks');
    expect(types(planRules('appointments today', 'en'))).toEqual(['kpi:appointments', 'agenda']);
    expect(planRules('new contacts this week', 'en').tiles[0].config.range).toBe('this_week');
    expect(types(planRules('unread messages', 'en'))).toEqual(['kpi:unread_conversations', 'inbox']);
  });

  it('gives an overview for anything else, combines two subjects, and follows up on the last question', () => {
    const other = planRules('Wie wird das Wetter morgen?');
    expect(other.fallback).toBe(true);
    expect(other.intents).toEqual(['overview']);
    expect(other.tiles.every((x) => x.optional)).toBe(true);
    expect(other.say).toContain('Übersicht');
    expect(planRules('Gib mir einen Überblick').fallback).toBe(false);
    const both = planRules('Offene Deals und Termine heute');
    expect(both.intents).toEqual(['deals', 'appointments']);
    expect(both.tiles.length).toBeLessThanOrEqual(8);
    expect(both.tiles.slice(0, 3).every((x) => x.type === 'kpi')).toBe(true);
    // "und nur meine?" continues the deals question with the "mine" filter
    const follow = planRules('und nur meine?', 'de', ['Termine heute', 'Offene Deals']);
    expect(follow.intents).toEqual(['deals']);
    expect(follow.tiles.find((x) => x.type === 'list')!.config.mine).toBe(true);
  });

  it('recognises a request for an action and does not mistake "zeig mir" for one', () => {
    const mail = planRules('Schick eine Mail an Anna Müller');
    expect(mail.action).toBe('Schick eine Mail an Anna Müller');
    expect(mail.tiles).toEqual([]);
    expect(mail.say).toContain('HyperLevel Agent');
    expect(planRules('Erstelle eine Übersicht der Deals').action).toBeNull();
    expect(planRules('Zeig mir die offenen Deals').action).toBeNull();
    const combined = planRules('Schick allen überfälligen Rechnungen eine Erinnerung');
    expect(combined.action).not.toBeNull();
    expect(types(combined)).toContain('kpi:overdue_invoices');
  });
});

describe('schema and validation', () => {
  const reg = new WidgetRegistry();
  registerCoreWidgets(reg);
  const env = { app: { services: {} } as any, locationId: 'x' };

  it('the answer schema is strict-structured-output compatible and offers only reading widgets', () => {
    const allowed = focusTypes(reg).map((d) => d.type);
    expect(allowed).toEqual(expect.arrayContaining(['kpi', 'chart', 'list', 'pipeline', 'agenda', 'inbox', 'tasks']));
    for (const t of ['notes', 'embed', 'actions', 'plugin']) expect(allowed).not.toContain(t);
    expect(strictCompatible(focusSchema(allowed))).toBe(true);
  });

  it('drops unknown or excluded types, unknown fields and invalid values; tiles with an invalid preset go entirely', () => {
    const r = validateTiles(
      [
        { type: 'hologramm', title: 'Magie', config: {} },
        { type: 'embed', title: 'Seite', config: { url: 'https://www.youtube.com/watch?v=x' } },
        { type: 'notes', title: 'Notiz', config: { text: 'Umsatz: 1.000.000 €' } },
        { type: 'list', title: 'Große Deals', config: { entity: 'deals', min_value: 5000, magic: 1, limit: 9999 } },
        { type: 'list', title: 'Kaputt', config: { entity: 'deals', status: 'irgendwas' } },
        { type: 'kpi', title: '', config: { preset: 'gibt_es_nicht' } },
        { type: 'kpi', title: 'Umsatz 48.000 €', config: { preset: 'paid_revenue', range: 'this_month' } },
        { type: 'kpi', title: 'doppelt', config: { preset: 'paid_revenue', range: 'this_month' } },
      ],
      reg,
      env,
      'Zeig mir Deals über 5000',
      { fromModel: true },
    );
    expect(r.tiles.map((x) => x.type)).toEqual(['list', 'kpi']);
    const list = r.tiles[0];
    expect(list.config).not.toHaveProperty('magic');
    expect(list.config.min_value).toBe(5000);
    expect(list.config.limit).toBe(30); // clamped to the field's maximum
    expect(list.config.status).toBe('open'); // not given → the default
    expect(list.title).toBe('Große Deals');
    expect(list).toMatchObject({ w: 6, h: 4 });
    // a title with a number the person never said is replaced by the widget's own name
    expect(r.tiles[1].title).toBe('');
    expect(r.dropped.join(' | ')).toMatch(/hologramm.*embed.*notes.*Liste.*irgendwas.*Kennzahl.*gibt_es_nicht/);
    // the rules' own titles are trusted ("Deals seit 14 Tagen unberührt")
    expect(validateTiles(planRules('Was ist überfällig?').tiles, reg, env, 'Was ist überfällig?').tiles.map((x) => x.title)).toContain('Deals seit 14 Tagen unberührt');
  });

  it('parses the model answer tolerantly and finds invented numbers', () => {
    expect(parseFocusAnswer('```json\n{"say":"ok","action":"","tiles":[{"type":"kpi","title":"","config_json":"{\\"preset\\":\\"open_deals\\"}"}]}\n```')).toMatchObject({ say: 'ok', tiles: [{ type: 'kpi', config: { preset: 'open_deals' } }] });
    expect(parseFocusAnswer('Hallo')).toBeNull();
    expect(parseFocusAnswer('{"say":"x","tiles":[{"type":"kpi","config_json":"kaputt"}]}')!.tiles[0].config).toBeNull();
    expect(noInventedNumbers('Hier sind deine Deals über 5.000 €.', 'Deals über 5000')).toBe(true);
    expect(noInventedNumbers('Du hast 12 offene Deals.', 'Offene Deals')).toBe(false);
    expect(noInventedNumbers('Hier sind deine Termine.', 'Termine heute')).toBe(true);
  });
});

// --- the endpoint ---------------------------------------------------------------------------------------------------------

let t: Awaited<ReturnType<typeof startTestApp>>;
let A = '';
let B = '';
let calls: { user: string; system: string; schema: any; purpose: string; userId: string | null }[] = [];
let answers: (object | string)[] = [];
let aiOn = false;
let me = '';
let member: Call;
let noDeals: Call;

const ask = (body: object, loc = A) => t.api.post('/api/focus/ask', body, { 'x-location-id': loc });
const tile = (r: any, type: string, entity?: string) => (r.data.tiles as any[]).find((x) => x.type === type && (!entity || x.config.entity === entity));
const addAiCalls = (n: number, userId = me, loc = A) => {
  for (let i = 0; i < n; i++) t.app.db.insert('ai_calls', { id: `f${i}-${Math.random()}`, location_id: loc, purpose: 'focus', model: 'm', status: 'ok', input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_micros: 0, ms: 1, user_id: userId, error: '', created_at: new Date().toISOString() });
};

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  A = t.api.location;
  me = t.app.db.get<{ id: string }>("SELECT id FROM users WHERE email = 'chef@example.com'")!.id;
  B = (await t.api.post('/api/locations', { name: 'Zweite Firma' })).data.id;
  const realReady = t.app.services.aiReady;
  t.app.services.aiReady = (loc: string) => (aiOn ? null : realReady(loc));
  t.app.services.aiRun = async (input: any) => {
    calls.push({ user: input.user, system: input.system?.[0]?.text ?? '', schema: input.schema, purpose: input.purpose, userId: input.userId });
    const next = answers.shift();
    if (next === undefined) throw new Error('keine Antwort vorbereitet');
    return { text: typeof next === 'string' ? next : JSON.stringify(next), model: 'fake', stopReason: 'end', usage: {}, ms: 1, costMicros: 0 };
  };
  // a deal in each sub-account, with names that tell them apart
  for (const [loc, name, value] of [
    [A, 'Alpha-Deal Firma A', 9000],
    [B, 'Beta-Deal Firma B', 7000],
  ] as const) {
    const pipe = (await t.api.post('/api/pipelines', { name: 'Vertrieb', stages: [{ name: 'Neu' }, { name: 'Angebot' }] }, { 'x-location-id': loc })).data;
    const r = await t.api.post('/api/opportunities', { pipeline_id: pipe.id, name, value, contact: { email: `${loc}@example.com`, first_name: 'Kunde' } }, { 'x-location-id': loc });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
  }
  await t.api.post('/api/users', { email: 'nur-a@example.com', name: 'Mia Member', password: 'passwort-12345', role: 'member', locations: [A], permissions: null });
  member = client(t.base, { 'x-pghl': '1' });
  await member('POST', '/api/auth/login', { email: 'nur-a@example.com', password: 'passwort-12345' });
  await t.api.post('/api/users', { email: 'ohne-deals@example.com', name: 'Otto Kontakte', password: 'passwort-12345', role: 'member', locations: [A], permissions: ['contacts', 'dashboard'] });
  noDeals = client(t.base, { 'x-pghl': '1' });
  await noDeals('POST', '/api/auth/login', { email: 'ohne-deals@example.com', password: 'passwort-12345' });
}, 60_000);
afterAll(() => t.close());

beforeEach(() => {
  calls = [];
  answers = [];
  aiOn = false;
  t.app.db.run("DELETE FROM ai_calls WHERE purpose = 'focus'");
});

describe('POST /api/focus/ask without AI', () => {
  it('answers "Offene Deals" by the rules: tiles with data and where it comes from, a sentence with real numbers', async () => {
    const r = await ask({ text: 'Offene Deals' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ source: 'rules', note: 'off', action: null });
    expect(calls).toHaveLength(0);
    expect(r.data.tiles.map((x: any) => x.type)).toEqual(['kpi', 'kpi', 'list', 'pipeline']);
    for (const x of r.data.tiles) {
      expect(x.source.label, x.type).toBeTruthy();
      expect(x.source.url, x.type).toMatch(/^\/app\//);
      expect(x.data.view.kind, x.type).toBeTruthy();
    }
    expect(r.data.tiles[0].source).toMatchObject({ label: 'Opportunities · gesamt', url: '/app/opportunities' });
    const list = tile(r, 'list', 'deals');
    expect(list.data.view.rows.map((x: any) => x.title)).toEqual(['Alpha-Deal Firma A']);
    // the sentence carries the key figures the widgets read – 9.000 € is the one open deal of sub-account A
    expect(r.data.say).toMatch(/^Hier sind die offenen Deals/);
    expect(r.data.say).toContain('Offener Pipeline-Wert: 9.000 €');
    expect(r.data.say).toContain('Offene Deals: 1');
  });

  it('answers in English when asked to, and every chip gives a view', async () => {
    const en = await ask({ text: 'Umsatz diesen Monat', lang: 'en' });
    expect(en.data.tiles[0]).toMatchObject({ title: 'Paid revenue', source: { label: 'Invoices · this month', url: '/app/invoices' } });
    expect(en.data.say).toMatch(/^This is your revenue this month\. Paid revenue: €0/);
    for (const chip of ['Was ist überfällig?', 'Termine heute', 'Neue Kontakte diese Woche', 'Ungelesene Nachrichten']) {
      const r = await ask({ text: chip });
      expect(r.status, chip).toBe(200);
      expect(r.data.tiles.length, chip).toBeGreaterThan(0);
    }
  });

  it('offers the agent for an action and changes nothing at all', async () => {
    const count = () => t.app.db.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM opportunities) + (SELECT COUNT(*) FROM contacts) + (SELECT COUNT(*) FROM tasks) + (SELECT COUNT(*) FROM messages) + (SELECT COUNT(*) FROM audit_log) + (SELECT COUNT(*) FROM boards) AS n')!.n;
    const before = count();
    const r = await ask({ text: 'Schick eine Mail an Anna Müller' });
    expect(r.data.action).toBe('Schick eine Mail an Anna Müller');
    expect(r.data.say).toContain('HyperLevel Agent');
    await ask({ text: 'Was ist überfällig?' });
    await t.api.get(`/api/focus/ask?text=${encodeURIComponent('Offene Deals')}`);
    expect(count()).toBe(before);
  });

  it('keeps questions within bounds', async () => {
    expect((await ask({ text: '' })).status).toBe(400);
    expect((await ask({ text: 'a' })).status).toBe(400);
    expect((await ask({ text: 'x'.repeat(1001) })).status).toBe(400);
    expect((await ask({ text: 'Offene Deals', history: ['Termine', 5, { x: 1 }] })).status).toBe(200);
  });

  it('tells the page whether AI answers and whether a view can become a board', async () => {
    expect((await t.api.get('/api/focus/status')).data).toMatchObject({ ai: false, hourly: 40, used: 0, can_save: true });
    aiOn = true;
    expect((await t.api.get('/api/focus/status')).data).toMatchObject({ ai: true, reason: null });
    const r = await noDeals('GET', '/api/focus/status', undefined, { 'x-location-id': A });
    expect(r.data.can_save).toBe(true);
  });
});

describe('with AI (faked model)', () => {
  it('lets the model pick widgets, validated against the catalogue; the numbers still come from the data', async () => {
    aiOn = true;
    answers.push({
      say: 'Hier sind deine großen Deals.',
      action: '',
      tiles: [
        { type: 'list', title: 'Deals über 5.000 €', config_json: '{"entity":"deals","min_value":5000,"zauber":true}' },
        { type: 'kpi', title: '', config_json: '{"preset":"open_pipeline_value"}' },
        { type: 'hologramm', title: 'Magie', config_json: '' },
      ],
    });
    const r = await ask({ text: 'Zeig mir die Deals über 5000 €', history: ['Termine heute'] });
    expect(r.data).toMatchObject({ source: 'ai', note: null });
    expect(r.data.tiles.map((x: any) => x.type)).toEqual(['list', 'kpi']);
    expect(tile(r, 'list').config).not.toHaveProperty('zauber');
    expect(tile(r, 'list').data.view.rows.map((x: any) => x.title)).toEqual(['Alpha-Deal Firma A']);
    expect(r.data.say).toBe('Hier sind deine großen Deals. Offener Pipeline-Wert: 9.000 €.');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ purpose: 'focus', userId: me });
    expect(strictCompatible(calls[0].schema)).toBe(true);
    expect(calls[0].user).toContain('• list – Liste');
    expect(calls[0].user).not.toContain('• embed');
    expect(calls[0].user).toContain('Termine heute');
    expect(calls[0].user).toContain('Zeig mir die Deals über 5000 €');
    expect(calls[0].system).toContain('NIEMALS Zahlen');
  });

  it('never repeats a number the model made up', async () => {
    aiOn = true;
    answers.push({ say: 'Du hast 42 offene Deals im Wert von 1 Mio. €.', action: '', tiles: [{ type: 'kpi', title: '42 Deals', config_json: '{"preset":"open_deals"}' }] });
    const r = await ask({ text: 'Offene Deals' });
    expect(r.data.source).toBe('ai');
    expect(r.data.say).not.toContain('42');
    expect(r.data.say).toBe('Das habe ich dazu gefunden. Offene Deals: 1.');
    expect(r.data.tiles[0].title).toBe('Offene Deals');
  });

  it('falls back to the rules when the answer is unusable, the model fails, or only invalid tiles come back', async () => {
    aiOn = true;
    answers.push('kein JSON');
    const garbage = await ask({ text: 'Offene Deals' });
    expect(garbage.data).toMatchObject({ source: 'rules', note: 'invalid' });
    expect(garbage.data.tiles.map((x: any) => x.type)).toEqual(['kpi', 'kpi', 'list', 'pipeline']);
    answers.push({ say: 'x', action: '', tiles: [{ type: 'hologramm', title: '', config_json: '' }, { type: 'embed', title: '', config_json: '{"url":"https://evil.example"}' }] });
    expect((await ask({ text: 'Termine heute' })).data).toMatchObject({ source: 'rules', note: 'invalid' });
    // no answer prepared → the fake throws like a provider outage
    const failed = await ask({ text: 'Termine heute' });
    expect(failed.data).toMatchObject({ source: 'rules', note: 'error' });
    expect(failed.data.tiles.map((x: any) => x.type)).toEqual(['kpi', 'agenda']);
    // rules_only skips the model
    const rules = await ask({ text: 'Offene Deals', rules_only: true });
    expect(rules.data).toMatchObject({ source: 'rules', note: 'rules' });
    expect(calls).toHaveLength(3);
  });

  it('keeps an action from the model as an offer, never as something done', async () => {
    aiOn = true;
    answers.push({ say: 'Fokus zeigt nur an – der HyperLevel Agent kann die Mail schreiben.', action: 'Eine Mail an Anna schreiben', tiles: [] });
    const r = await ask({ text: 'Schreib Anna eine Mail wegen des Angebots' });
    expect(r.data).toMatchObject({ source: 'ai', action: 'Schreib Anna eine Mail wegen des Angebots', tiles: [] });
  });
});

describe('limits', () => {
  it('answers by the rules once the hourly AI limit is used up – per person', async () => {
    aiOn = true;
    addAiCalls(40);
    const r = await ask({ text: 'Offene Deals' });
    expect(r.data).toMatchObject({ source: 'rules', note: 'limit' });
    expect(calls).toHaveLength(0);
    expect((await t.api.get('/api/focus/status')).data).toMatchObject({ ai: false, used: 40 });
    // somebody else's questions do not count for me
    t.app.db.run("DELETE FROM ai_calls WHERE purpose = 'focus'");
    addAiCalls(40, 'jemand-anderes');
    answers.push({ say: 'Deine Deals.', action: '', tiles: [{ type: 'kpi', title: '', config_json: '{"preset":"open_deals"}' }] });
    expect((await ask({ text: 'Offene Deals' })).data.source).toBe('ai');
  });

  it('refuses more than 40 questions a minute', async () => {
    const r = await member('POST', '/api/focus/ask', { text: 'Offene Deals' }, { 'x-location-id': A });
    expect(r.status).toBe(200);
    let last = 200;
    for (let i = 0; i < 40 && last === 200; i++) last = (await member('POST', '/api/focus/ask', { text: 'Termine heute', rules_only: true }, { 'x-location-id': A })).status;
    expect(last).toBe(429);
  });
});

describe('rights and sub-accounts', () => {
  it('reads every tile in the sub-account asked for – never another one', async () => {
    const inB = await ask({ text: 'Offene Deals' }, B);
    expect(tile(inB, 'list', 'deals').data.view.rows.map((x: any) => x.title)).toEqual(['Beta-Deal Firma B']);
    expect(inB.data.say).toContain('7.000 €');
    expect(JSON.stringify(inB.data)).not.toContain('Alpha-Deal');
    const inA = await ask({ text: 'Offene Deals' }, A);
    expect(JSON.stringify(inA.data)).not.toContain('Beta-Deal');
  });

  it('a member cannot ask in a sub-account they do not belong to', async () => {
    const r = await noDeals('POST', '/api/focus/ask', { text: 'Offene Deals' }, { 'x-location-id': B });
    expect(r.status).toBe(403);
  });

  it('a tile of an area the person may not open is locked (and left out of the general overview)', async () => {
    const r = await noDeals('POST', '/api/focus/ask', { text: 'Offene Deals' }, { 'x-location-id': A });
    expect(r.status).toBe(200);
    const list = r.data.tiles.find((x: any) => x.type === 'list');
    expect(list.data.view.kind).toBe('locked');
    expect(tile(r, 'pipeline').data.view.kind).toBe('locked');
    expect(r.text).not.toContain('Alpha-Deal');
    const overview = await noDeals('POST', '/api/focus/ask', { text: 'Wie wird das Wetter?' }, { 'x-location-id': A });
    expect(overview.data.tiles.every((x: any) => x.data.view.kind !== 'locked')).toBe(true);
    expect(overview.data.tiles.some((x: any) => x.type === 'inbox')).toBe(false);
  });
});

describe('MCP tool ghl_focus_view', () => {
  let keyA = '';
  let readKey = '';
  let id = 0;
  const mcp = async (name: string, args: any, key: string) => {
    const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
    const j: any = await r.json();
    const text = j.result?.content?.[0]?.text ?? '';
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* error text */
    }
    return { isError: !!j.result?.isError, text, data, error: j.error };
  };
  beforeAll(async () => {
    keyA = (await t.api.post('/api/api-keys', { name: 'Fokus A' }, { 'x-location-id': A })).data.key;
    readKey = (await t.api.post('/api/agency/api-keys', { name: 'Nur lesen', scope: 'read' })).data.key;
  });

  it('is a read-only tool the agent may run without asking', () => {
    const tool = FOCUS_TOOLS[0];
    expect(tool.name).toBe('ghl_focus_view');
    expect(classify(tool)).toBe('read');
    expect(tool.inputSchema.required).toEqual(['location_id', 'question']);
    // it reads through GET, which a read-only tool may always do
    expect(routeProblem('GET', '/api/focus/ask?text=x', 'read')).toBeNull();
  });

  it('returns the same say and tiles with resolved data, scoped to the key’s sub-account', async () => {
    const list = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${keyA}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(((await list.json()) as any).result.tools.some((x: any) => x.name === 'ghl_focus_view')).toBe(true);
    const r = await mcp('ghl_focus_view', { location_id: A, question: 'Offene Deals' }, keyA);
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({ source: 'rules', action: null, link: '/app/focus' });
    expect(r.data.say).toContain('9.000 €');
    const deals = r.data.tiles.find((x: any) => x.type === 'list');
    expect(deals.source).toMatchObject({ url: '/app/opportunities' });
    expect(deals.data.rows.map((x: any) => x.title)).toEqual(['Alpha-Deal Firma A']);
    // a key for A cannot look into B
    const other = await mcp('ghl_focus_view', { location_id: B, question: 'Offene Deals' }, keyA);
    expect(other.isError).toBe(true);
    expect(other.text).toMatch(/nur für einen Sub-Account/);
  });

  it('works with a read-only agency key in any sub-account it names, in English and without AI on request', async () => {
    aiOn = true;
    const r = await mcp('ghl_focus_view', { location_id: B, question: 'open deals', lang: 'en', rules_only: true, history: ['appointments today'] }, readKey);
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({ source: 'rules', note: 'rules' });
    expect(r.data.tiles[0].title).toBe('Open pipeline value');
    expect(JSON.stringify(r.data)).toContain('Beta-Deal Firma B');
    expect(calls).toHaveLength(0);
    expect((await mcp('ghl_focus_view', { location_id: B }, readKey)).error?.message).toMatch(/Fehlende Parameter/);
  });
});
