import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { client, type Call } from './security-fixtures.js';
import { strictCompatible } from '../server/services/openai.js';
import { PATCH_SCHEMA, describeCatalogue, opsFromAi, parseAnswer } from '../server/services/boards-compose.js';
import { WidgetRegistry } from '../server/services/boards-widgets.js';
import { registerCoreWidgets } from '../server/services/boards-widgets-core.js';

/** "Sag einfach, was du sehen willst": the model is faked; everything after it (validation, preview, confirmation, versions) is real. */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let colleague: Call;
let viewer: Call;
let board: any;
let calls: { user: string; system: string; schema: any; purpose: string; userId: string | null }[] = [];
let answers: object[] = [];

/** One op the way the model writes it: every field present, "not set" = '' / null. */
const op = (o: Record<string, unknown>) => ({ op: 'add', id: '', ref: '', type: '', title: '', config_json: '', x: null, y: null, w: null, h: null, dw: null, dh: null, placement: '', name: '', accent: '', ...o });
const say = (message: string, ops: object[] = [], unsupported: { need: string; reason: string }[] = []) => answers.push({ message, ops, unsupported });

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  t.app.services.aiRun = async (input: any) => {
    calls.push({ user: input.user, system: input.system?.[0]?.text ?? '', schema: input.schema, purpose: input.purpose, userId: input.userId });
    const next = answers.shift();
    if (!next) throw new Error('keine Antwort vorbereitet');
    return { text: JSON.stringify(next), model: 'fake', stopReason: 'end', usage: {}, ms: 1, costMicros: 0 };
  };
  await t.api.post('/api/users', { email: 'kollege@example.com', name: 'Karl Kollege', password: 'passwort-12345', role: 'member', locations: [loc], permissions: ['dashboard'] });
  await t.api.post('/api/users', { email: 'leser@example.com', name: 'Lena Leser', password: 'passwort-12345', role: 'member', locations: [loc], permissions: ['dashboard'] });
  colleague = client(t.base, { 'x-pghl': '1' });
  await colleague('POST', '/api/auth/login', { email: 'kollege@example.com', password: 'passwort-12345' });
  viewer = client(t.base, { 'x-pghl': '1' });
  await viewer('POST', '/api/auth/login', { email: 'leser@example.com', password: 'passwort-12345' });
  const pipe = (await t.api.post('/api/pipelines', { name: 'Verkauf', stages: [{ name: 'Lead' }] })).data;
  void pipe;
}, 60_000);
afterAll(() => t.close());

beforeEach(async () => {
  calls = [];
  answers = [];
  // a fresh board with a revenue chart for every test
  board = (await t.api.post('/api/boards', { name: 'Compose', scope: 'shared', team_access: 'edit' })).data;
  board = (await t.api.post(`/api/boards/${board.id}/patch`, { ops: [{ op: 'add', type: 'chart', config: { preset: 'revenue_by_month' }, title: 'Umsatzkurve' }] })).data.board;
  await t.api.put('/api/boards/prefs', { auto_apply: 'layout' });
});

const compose = (c: Call | null, body: object, id = board.id) => (c ? c('POST', `/api/boards/${id}/compose`, body, { 'x-location-id': loc }) : t.api.post(`/api/boards/${id}/compose`, body));

describe('schema and parsing', () => {
  it('the answer schema is a strict structured-output schema', () => {
    expect(strictCompatible(PATCH_SCHEMA)).toBe(true);
    expect(PATCH_SCHEMA.properties.ops.items.properties.op.enum).toEqual(['add', 'remove', 'move', 'resize', 'configure', 'rename', 'theme']);
  });

  it('turns the flat answer into patch ops (empty fields dropped, config parsed, theme reset kept)', () => {
    const r = opsFromAi([op({ type: 'list', ref: 'a', placement: 'top', config_json: '{"min_value":5000}' }), op({ op: 'resize', id: 'w1', dw: 2, dh: 1 }), op({ op: 'theme', accent: '' }), op({ op: 'add', type: 'kpi', config_json: '[1]' })]);
    expect(r.ops[0]).toEqual({ op: 'add', type: 'list', ref: 'a', placement: 'top', config: { min_value: 5000 } });
    expect(r.ops[1]).toEqual({ op: 'resize', id: 'w1', dw: 2, dh: 1 });
    expect(r.ops[2]).toEqual({ op: 'theme', accent: '' });
    expect(r.errors).toEqual(['Schritt 4: config_json ist kein gültiges JSON-Objekt']);
    expect(parseAnswer('```json\n{"message":"ok","ops":[],"unsupported":[]}\n```')).toMatchObject({ message: 'ok' });
    expect(parseAnswer('Hallo')).toBeNull();
  });

  it('describes every widget type with its fields for the model', () => {
    const reg = new WidgetRegistry();
    registerCoreWidgets(reg);
    const text = describeCatalogue(reg.catalogue());
    for (const type of ['kpi', 'chart', 'list', 'pipeline', 'agenda', 'inbox', 'tasks', 'wiki', 'notes', 'embed', 'actions', 'calc', 'plugin']) expect(text).toContain(`• ${type} – `);
    expect(text).toContain('revenue_by_month=Umsatz je Monat');
    expect(text).toContain('min_value: Mindestwert (€)');
  });
});

describe('compose: the example request', () => {
  it('shows a preview card first and changes nothing until it is confirmed; then it is a version with the wish attached', async () => {
    const chart = board.spec.widgets[0];
    say('Ich lege oben die großen Deals an, daneben deine Aufgaben, und vergrößere die Kurve.', [
      op({ type: 'list', ref: 'neu1', placement: 'top', title: 'Offene Deals über 5.000 €', config_json: '{"entity":"deals","status":"open","min_value":5000}' }),
      op({ type: 'tasks', ref: 'neu2', placement: 'beside:neu1', config_json: '{"due":"today","mine":true}' }),
      op({ op: 'resize', id: chart.id, dw: 2, dh: 1 }),
    ]);
    const r = await compose(null, { prompt: 'Zeig mir oben die offenen Deals über 5.000 €, daneben meine Aufgaben für heute, und mach die Umsatzkurve größer' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.applied).toBe(false);
    const p = r.data.proposal;
    expect(p).toMatchObject({ status: 'pending', risk: 'normal', base_version: 2 });
    expect(p.changes.map((c: any) => c.kind)).toEqual(['add', 'add', 'resize']);
    expect(p.changes[0].text).toContain('Offene Deals über 5.000 €');
    expect(p.after.spec.widgets).toHaveLength(3);
    // the board is untouched
    expect((await t.api.get(`/api/boards/${board.id}`)).data).toMatchObject({ version: 2, widgets: 1 });
    // the model got the catalogue, the board and the wish – and the schema
    expect(calls).toHaveLength(1);
    expect(calls[0].purpose).toBe('boards');
    expect(calls[0].user).toContain('• list – Liste');
    expect(calls[0].user).toContain(chart.id);
    expect(calls[0].user).toContain('Zeig mir oben die offenen Deals');
    expect(calls[0].system).toContain('Texte in Notizen');
    expect(strictCompatible(calls[0].schema)).toBe(true);
    // confirm
    const ok = await t.api.post(`/api/boards/${board.id}/proposals/${p.id}/apply`, {});
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(ok.data.board).toMatchObject({ version: 3, widgets: 3, can_undo: true });
    const versions = (await t.api.get(`/api/boards/${board.id}/versions`)).data.versions;
    expect(versions[0]).toMatchObject({ n: 3, kind: 'agent', prompt: expect.stringContaining('Umsatzkurve größer') });
    // applying twice is refused, undo is one call
    expect((await t.api.post(`/api/boards/${board.id}/proposals/${p.id}/apply`, {})).status).toBe(409);
    expect((await t.api.post(`/api/boards/${board.id}/undo`, {})).data).toMatchObject({ version: 2, widgets: 1 });
    // the wish and the change are both in the audit log
    const log = (await t.api.get('/api/audit?limit=60')).data as any[];
    expect(log.some((a) => a.action === 'boards.compose' && a.summary.includes('Zeig mir oben'))).toBe(true);
    expect(log.some((a) => a.action === 'boards.patch' && a.summary.includes('Offene Deals'))).toBe(true);
  });

  it('can be declined – and the declined proposal cannot be applied any more', async () => {
    say('Neue Notiz.', [op({ type: 'notes', config_json: '{"text":"x"}' })]);
    const p = (await compose(null, { prompt: 'Lege eine Notiz an' })).data.proposal;
    expect((await t.api.post(`/api/boards/${board.id}/proposals/${p.id}/reject`, {})).data.ok).toBe(true);
    expect((await t.api.post(`/api/boards/${board.id}/proposals/${p.id}/apply`, {})).status).toBe(409);
    expect((await t.api.get(`/api/boards/${board.id}`)).data.widgets).toBe(1);
  });
});

describe('compose: auto-apply and risk', () => {
  it('applies low-risk layout changes at once when the person wants that, and says how to undo them', async () => {
    const chart = board.spec.widgets[0];
    say('Die Kurve wird größer.', [op({ op: 'resize', id: chart.id, dw: 2, dh: 1 })]);
    const r = await compose(null, { prompt: 'Mach die Umsatzkurve größer' });
    expect(r.data).toMatchObject({ ok: true, applied: true, version: 3 });
    expect(r.data.proposal).toMatchObject({ status: 'applied', risk: 'low' });
    expect(r.data.board.spec.widgets[0].layout.lg.w).toBe(chart.layout.lg.w + 2);
    expect((await t.api.post(`/api/boards/${board.id}/undo`, {})).data.spec.widgets[0].layout.lg.w).toBe(chart.layout.lg.w);
  });

  it('asks first when the person switched auto-apply off, with an explicit preview request, or when more than the layout changes', async () => {
    const chart = board.spec.widgets[0];
    await t.api.put('/api/boards/prefs', { auto_apply: 'off' });
    say('Größer.', [op({ op: 'resize', id: chart.id, dw: 2 })]);
    expect((await compose(null, { prompt: 'Kurve größer' })).data).toMatchObject({ applied: false, proposal: { status: 'pending', risk: 'low' } });
    await t.api.put('/api/boards/prefs', { auto_apply: 'layout' });
    say('Größer.', [op({ op: 'resize', id: chart.id, dw: 2 })]);
    expect((await compose(null, { prompt: 'Kurve größer', preview: true })).data.applied).toBe(false);
    say('Neue Notiz.', [op({ type: 'notes', config_json: '{"text":"x"}' })]);
    expect((await compose(null, { prompt: 'Notiz dazu' })).data).toMatchObject({ applied: false, proposal: { risk: 'normal' } });
  });

  it('never applies anything that embeds an address or adds buttons without a confirmation', async () => {
    say('Einbettung.', [op({ type: 'embed', config_json: '{"url":"https://docs.google.com/document/d/1"}' })]);
    const r = await compose(null, { prompt: 'Bette das Dokument ein' });
    expect(r.data).toMatchObject({ applied: false, proposal: { risk: 'high', status: 'pending' } });
    say('Knöpfe.', [op({ type: 'actions', config_json: '{"actions":[{"label":"Aufgabe","kind":"task"}]}' })]);
    expect((await compose(null, { prompt: 'Knopf für neue Aufgabe' })).data).toMatchObject({ applied: false, proposal: { risk: 'high' } });
    expect((await t.api.get(`/api/boards/${board.id}`)).data.widgets).toBe(1);
  });
});

describe('compose: bad and impossible requests', () => {
  it('gives the model one chance to repair an invalid answer, with the reasons', async () => {
    say('Hologramm.', [op({ type: 'hologramm' })]);
    say('Dann eben eine Notiz.', [op({ type: 'notes', config_json: '{"text":"ok"}' })]);
    const r = await compose(null, { prompt: 'Zeig ein Hologramm' });
    expect(r.data.proposal.changes[0].text).toContain('Notiz');
    expect(calls).toHaveLength(2);
    expect(calls[1].user).toContain('Dein letzter Vorschlag war nicht gültig');
    expect(calls[1].user).toContain('Unbekanntes Widget „hologramm“');
  });

  it('declines when the repair fails too, and still reports what the model could not do', async () => {
    say('Erfunden.', [op({ type: 'hologramm' })]);
    say('Immer noch erfunden.', [op({ type: 'hologramm2' })], [{ need: 'Ein Hologramm anzeigen', reason: 'Kein Widget dafür' }]);
    const r = await compose(null, { prompt: 'Zeig ein Hologramm' });
    expect(r.data).toMatchObject({ ok: false, proposal: null, applied: false });
    expect(r.data.errors[0]).toMatch(/Unbekanntes Widget/);
    expect(r.data.unsupported[0].need).toBe('Ein Hologramm anzeigen');
    expect((await t.api.get(`/api/boards/${board.id}`)).data.version).toBe(2);
  });

  it('refuses invalid config values and fields the type does not have', async () => {
    say('x', [op({ type: 'list', config_json: '{"entity":"deals","magic":1}' })]);
    say('x', [op({ type: 'list', config_json: '{"limit":9999}' })]);
    const r = await compose(null, { prompt: 'Liste mit Magie' });
    expect(r.data.ok).toBe(false);
    expect(r.data.errors[0]).toMatch(/zwischen 3 und 30/);
    expect(calls[1].user).toContain('unbekanntes Feld „magic“');
  });

  it('offers what no widget can do (for the Werkstatt) when nothing else is asked', async () => {
    say('Dafür gibt es noch kein Widget.', [], [{ need: 'Das Wetter für Köln anzeigen', reason: 'Der Katalog hat kein Wetter-Widget' }]);
    const r = await compose(null, { prompt: 'Zeig mir das Wetter für Köln' });
    expect(r.data).toMatchObject({ ok: true, proposal: null, applied: false });
    expect(r.data.unsupported).toEqual([{ need: 'Das Wetter für Köln anzeigen', reason: 'Der Katalog hat kein Wetter-Widget' }]);
    expect(r.data.message).toContain('kein Widget');
  });

  it('keeps wishes within bounds: too short, too long, no model answer, hourly limit', async () => {
    expect((await compose(null, { prompt: 'a' })).status).toBe(400);
    expect((await compose(null, { prompt: 'x'.repeat(1001) })).status).toBe(400);
    expect((await compose(null, { prompt: '' })).status).toBe(400);
    answers.push({ kein: 'schema' });
    answers.push({ kein: 'schema' });
    expect((await compose(null, { prompt: 'Mach was Schönes' })).status).toBe(502);
    const me = t.app.db.get<{ id: string }>("SELECT id FROM users WHERE email = 'chef@example.com'")!.id;
    for (let i = 0; i < 40; i++) t.app.db.insert('ai_calls', { id: `c${i}-${Date.now()}`, location_id: loc, purpose: 'boards', model: 'm', status: 'ok', input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_micros: 0, ms: 1, user_id: me, error: '', created_at: new Date().toISOString() });
    const limited = await compose(null, { prompt: 'Noch ein Wunsch' });
    expect(limited.status).toBe(429);
    t.app.db.run("DELETE FROM ai_calls WHERE purpose = 'boards'");
  });
});

describe('compose: who may ask and who may confirm', () => {
  it('only people who may edit the board can ask; only the asker confirms', async () => {
    say('Notiz.', [op({ type: 'notes', config_json: '{"text":"x"}' })]);
    const p = (await compose(colleague, { prompt: 'Notiz anlegen' })).data.proposal;
    expect(p.status).toBe('pending');
    // the admin cannot apply the colleague's proposal, a read-only viewer cannot even ask
    expect((await t.api.post(`/api/boards/${board.id}/proposals/${p.id}/apply`, {})).status).toBe(403);
    await t.api.patch(`/api/boards/${board.id}`, { team_access: 'view' });
    say('Notiz.', [op({ type: 'notes', config_json: '{"text":"x"}' })]);
    const denied = await compose(viewer, { prompt: 'Notiz anlegen' });
    expect(denied.status).toBe(403);
    expect(calls).toHaveLength(1);
    expect((await colleague('POST', `/api/boards/${board.id}/proposals/${p.id}/apply`, {}, { 'x-location-id': loc })).status).toBe(403);
    await t.api.patch(`/api/boards/${board.id}`, { team_access: 'edit' });
    const ok = await colleague('POST', `/api/boards/${board.id}/proposals/${p.id}/apply`, {}, { 'x-location-id': loc });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(ok.data.board.version).toBe(3);
    const v = (await t.api.get(`/api/boards/${board.id}/versions`)).data.versions[0];
    expect(v).toMatchObject({ kind: 'agent', actor: 'Karl Kollege' });
  });

  it('a proposal expires, and one that no longer fits the board is refused instead of half-applied', async () => {
    say('Notiz.', [op({ type: 'notes', config_json: '{"text":"x"}' })]);
    const p = (await compose(null, { prompt: 'Notiz anlegen' })).data.proposal;
    t.app.db.run('UPDATE board_proposals SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), p.id);
    const gone = await t.api.post(`/api/boards/${board.id}/proposals/${p.id}/apply`, {});
    expect(gone.status).toBe(409);
    expect(gone.data.error).toMatch(/abgelaufen/);
    // a proposal that points at a widget which has been removed in the meantime
    say('Größer.', [op({ op: 'resize', id: board.spec.widgets[0].id, dw: 2 })]);
    const q = (await compose(null, { prompt: 'Kurve größer', preview: true })).data.proposal;
    await t.api.post(`/api/boards/${board.id}/patch`, { ops: [{ op: 'remove', id: board.spec.widgets[0].id }] });
    const stale = await t.api.post(`/api/boards/${board.id}/proposals/${q.id}/apply`, {});
    expect(stale.status).toBe(409);
    expect(stale.data.error).toMatch(/passt nicht mehr/);
  });

  it('lists the pending proposals of the person (a reload keeps the preview)', async () => {
    say('Notiz.', [op({ type: 'notes', config_json: '{"text":"x"}' })]);
    const p = (await compose(null, { prompt: 'Notiz anlegen' })).data.proposal;
    const list = (await t.api.get(`/api/boards/${board.id}/proposals`)).data.proposals;
    expect(list.map((x: any) => x.id)).toContain(p.id);
    expect(list[0].changes[0].text).toContain('Neu');
    // somebody else does not see them
    expect((await colleague('GET', `/api/boards/${board.id}/proposals`, undefined, { 'x-location-id': loc })).data.proposals).toEqual([]);
  });

  it('records spoken requests as such', async () => {
    say('Notiz.', [op({ type: 'notes', config_json: '{"text":"x"}' })]);
    const r = await compose(null, { prompt: 'Lege eine Notiz an', voice: true });
    expect(r.data.proposal.via).toBe('voice');
    const log = (await t.api.get('/api/audit?limit=20')).data as any[];
    expect(log.find((a) => a.action === 'boards.compose')?.summary).toContain('gesprochen');
  });
});
