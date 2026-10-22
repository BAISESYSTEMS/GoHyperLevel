import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanSteps } from '../server/modules/call-scripts.js';
import { applySnapshot, exportSnapshot } from '../server/services/snapshots.js';
import { startTestApp } from './helpers.js';

/** Call scripts (modules/call-scripts.ts): steps with branches, scope per dialer list or pipeline, placeholders, snapshot, undo. */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let pipe: any;
let anna: any;
const steps = [
  { id: 'hi', title: 'Begrüßung', text: 'Hallo {{contact.first_name}}, hier ist {{location.name}}.', options: [{ label: 'Interesse', next: 'offer' }, { label: 'Kein Interesse', next: '' }, { label: 'Kaputt', next: 'gibtsnicht' }] },
  { id: 'offer', title: 'Angebot', text: 'Wir haben ein Angebot.', options: [] },
];
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  pipe = (await t.api.post('/api/pipelines', { name: 'Webdesign' })).data;
  anna = (await t.api.post('/api/contacts', { first_name: 'Anna', email: 'anna@example.com', phone: '+4915100000001' })).data;
});
afterAll(() => t?.close());

describe('call scripts', () => {
  it('cleans steps: ids, unknown jump targets end the script, empty answers go', () => {
    const out = cleanSteps([{ title: '', text: 'x', options: [{ label: '', next: 'a' }, { label: 'Ja', next: 'nope' }] }]);
    expect(out[0].title).toBe('Schritt 1');
    expect(out[0].options).toEqual([{ label: 'Ja', next: '' }]);
    expect(() => cleanSteps([])).toThrow(/Mindestens/);
  });

  it('creates scripts; references into other sub-accounts are dropped', async () => {
    expect((await t.api.post('/api/call-scripts', { name: 'Leer', steps: [] })).status).toBe(400);
    const general = await t.api.post('/api/call-scripts', { name: 'Allgemein', steps: [{ title: 'Hallo', text: 'Guten Tag {{contact.first_name|du}}' }] });
    expect(general.status, JSON.stringify(general.data)).toBe(200);
    const web = await t.api.post('/api/call-scripts', { name: 'Webdesign', steps, pipeline_ids: [pipe.id, 'fremd'], dialer_list_ids: ['fremd'] });
    expect(web.data.pipeline_ids).toEqual([pipe.id]);
    expect(web.data.dialer_list_ids).toEqual([]);
    expect(web.data.steps[0].options.map((o: any) => o.next)).toEqual(['offer', '', '']);
    expect((await t.api.post('/api/call-scripts', { name: 'X', steps, scorecard_id: 'fremd' })).status).toBe(400);
  });

  it('picks the script for a call: open deal in the pipeline, else the general one – with the contact filled in', async () => {
    let r = (await t.api.get(`/api/call-scripts/for?contact_id=${anna.id}`)).data;
    expect(r.script.name).toBe('Allgemein');
    expect(r.script.steps[0].text).toBe('Guten Tag Anna');
    await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: anna.id, name: 'Website' });
    r = (await t.api.get(`/api/call-scripts/for?contact_id=${anna.id}`)).data;
    expect(r.script.name).toBe('Webdesign');
    expect(r.script.steps[0].text).toMatch(/^Hallo Anna, hier ist /);
    expect(r.others.map((o: any) => o.name)).toEqual(['Allgemein']);
    expect((await t.api.get('/api/call-scripts/for?contact_id=fremd')).status).toBe(404);
  });

  it('a script of the dialer list wins', async () => {
    const list = await t.api.post('/api/dialer/lists', { name: 'Kaltakquise', source: 'manual', contact_ids: [anna.id] });
    expect(list.status, JSON.stringify(list.data)).toBe(200);
    await t.api.post('/api/call-scripts', { name: 'Liste', steps: [{ title: 'Kalt', text: 'Kurz und knapp' }], dialer_list_ids: [list.data.id] });
    expect((await t.api.get(`/api/call-scripts/for?contact_id=${anna.id}&list_id=${list.data.id}`)).data.script.name).toBe('Liste');
  });

  it('inactive scripts are not offered; delete can be undone', async () => {
    const all = (await t.api.get('/api/call-scripts')).data as any[];
    const general = all.find((s) => s.name === 'Allgemein');
    await t.api.patch(`/api/call-scripts/${general.id}`, { active: false });
    const other = (await t.api.post('/api/contacts', { email: 'ohne@example.com' })).data;
    expect((await t.api.get(`/api/call-scripts/for?contact_id=${other.id}`)).data.script).toBeNull();
    const del = await t.api.del(`/api/call-scripts/${general.id}`);
    expect(del.status).toBe(200);
    expect((await t.api.post(`/api/undo/${del.headers.get('x-undo-id')}`, {})).status).toBe(200);
    expect(t.app.db.get('SELECT name, active FROM call_scripts WHERE id = ?', general.id)).toEqual({ name: 'Allgemein', active: 0 });
  });

  it('travels with a snapshot, pointing at the copied pipeline', async () => {
    const other = (await t.api.post('/api/locations', { name: 'Kopie' })).data.id as string;
    applySnapshot(t.app, other, JSON.parse(JSON.stringify(exportSnapshot(t.app, loc))));
    const copy = t.app.db.get<{ pipeline_ids: string; dialer_list_ids: string }>(`SELECT pipeline_ids, dialer_list_ids FROM call_scripts WHERE location_id = ? AND name = 'Webdesign'`, other)!;
    const newPipe = t.app.db.get<{ id: string }>(`SELECT id FROM pipelines WHERE location_id = ? AND name = 'Webdesign'`, other)!.id;
    expect(JSON.parse(copy.pipeline_ids)).toEqual([newPipe]);
    expect(JSON.parse(copy.dialer_list_ids)).toEqual([]);
  });

  it("never shows or changes another sub-account's scripts", async () => {
    const mine = (await t.api.get('/api/call-scripts')).data[0];
    const other = (await t.api.post('/api/locations', { name: 'Fremd' })).data.id as string;
    t.api.setLocation(other);
    expect((await t.api.get('/api/call-scripts')).data).toEqual([]);
    expect((await t.api.patch(`/api/call-scripts/${mine.id}`, { name: 'x' })).status).toBe(404);
    expect((await t.api.del(`/api/call-scripts/${mine.id}`)).status).toBe(404);
    t.api.setLocation(loc);
  });
});
