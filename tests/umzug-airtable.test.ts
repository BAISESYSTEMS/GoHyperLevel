import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { airtableMap, airtableRecord, airtableType, airtableValue, baseId } from '../server/services/umzug-airtable.js';
import { AIRTABLE_TOKEN, FakeAirtable } from './umzug3-fakes.js';
import { umzugHarness, type Harness } from './umzug2-harness.js';

let h: Harness;
const fake = new FakeAirtable();
let imported: any;
const creds = { token: AIRTABLE_TOKEN };
const objectType = (plural: string) => h.one('SELECT * FROM object_types WHERE location_id = ? AND plural = ?', plural);
const records = (key: string) => h.q('SELECT r.* FROM object_records r JOIN object_types t ON t.id = r.type_id WHERE r.location_id = ? AND t.key = ? ORDER BY r.created_at', key).map((r: any) => ({ ...r, properties: JSON.parse(r.properties) }));
const kunden = fake.tables.appBase1[0];

beforeAll(async () => {
  h = await umzugHarness();
  h.t.app.services.umzugFetch = fake.fetch;
  await h.fresh('Airtable');
});
afterAll(() => h.t.close());

describe('Airtable: pure parts', () => {
  it('maps field types', () => {
    const m = (type: string, extra: any = {}) => airtableMap({ id: 'f', name: 'F', type, ...extra });
    expect(m('singleSelect', { options: { choices: [{ name: 'A' }] } })).toEqual({ type: 'select', options: ['A'] });
    expect(m('singleSelect', { options: { choices: [] } })).toEqual({ type: 'text' });
    expect(m('multipleSelects', { options: { choices: [{ name: 'A' }] } })).toEqual({ type: 'multiselect', options: ['A'] });
    expect(m('multipleRecordLinks', { options: { linkedTableId: 'tblX' } })).toBe('link');
    expect(m('formula', { options: { result: { type: 'number' } } })).toEqual({ type: 'number' });
    expect(m('multipleLookupValues', { options: { result: { type: 'number' } } })).toEqual({ type: 'text' });
    expect(m('createdTime', { options: { result: { type: 'dateTime' } } })).toEqual({ type: 'datetime' });
    expect(m('button')).toBeUndefined();
    expect(m('currency')).toEqual({ type: 'currency' });
  });
  it('turns cells into simple values', () => {
    const v = (type: string, raw: unknown, extra: any = {}) => airtableValue({ id: 'f', name: 'F', type, ...extra }, raw);
    expect(v('percent', 0.125)).toBe(12.5);
    expect(v('duration', 5400)).toBe('1:30:00');
    expect(v('singleCollaborator', { id: 'u', email: 'a@b.de', name: 'Anna' })).toBe('Anna');
    expect(v('multipleAttachments', [{ filename: 'a.pdf' }, { filename: 'b.png' }])).toBe('a.pdf, b.png');
    expect(v('barcode', { type: 'code128', text: '4711' })).toBe('4711');
    expect(v('aiText', { state: 'generated', value: 'Hallo' })).toBe('Hallo');
    expect(v('multipleLookupValues', ['a', 'b'])).toBe('a, b');
    expect(v('checkbox', true)).toBe(true);
    expect(v('multipleSelects', ['a', { name: 'b' }])).toEqual(['a', 'b']);
    expect(v('multipleRecordLinks', ['rec1'])).toBeUndefined();
    expect(v('formula', 0.5, { options: { result: { type: 'percent' } } })).toBe(50);
  });
  it('builds the object type: primary field first and called "Name"', () => {
    const t = airtableType(fake.bases[0], kunden, false);
    expect(t.rec.singular).toBe('Kunden');
    expect(t.rec.properties[0]).toMatchObject({ ext: 'fldName', label: 'Name', primary: true, type: 'text' });
    expect(t.rec.properties.map((p) => p.label)).not.toContain('Aktion');
    expect(t.links).toEqual([{ field: 'fldProjekte', target: 'tblProjekte' }]);
    expect(airtableType(fake.bases[0], kunden, true).rec.singular).toBe('CRM › Kunden');
  });
  it('reads a record by field id and leaves links out', () => {
    const r = airtableRecord(fake.records.tblKunden[0], kunden);
    expect(r).toMatchObject({ ext: 'rec:recK1', type: 'tblKunden', created_at: '2024-01-10T08:00:00.000Z' });
    expect(r.values.fldProjekte).toBeUndefined();
    expect(r.values).toMatchObject({ fldName: 'Muster GmbH', fldQuote: 12.5, fldDauer: '1:30:00', fldBetreuer: 'Anna Alt', fldDateien: 'vertrag.pdf', fldLookup: 'Relaunch, Kampagne', fldSumme: 5800 });
  });
  it('reads a base id from a link and refuses nonsense', () => {
    expect(baseId('https://airtable.com/appAbCdEfGhIjKlM/tblX/viwY')).toBe('appAbCdEfGhIjKlM');
    expect(baseId('')).toBeUndefined();
    expect(() => baseId('foo')).toThrow(/Base-ID/);
  });
});

describe('Airtable: connect and preview', () => {
  it('refuses a wrong token and a bad base id, connects with the right token (never returned)', async () => {
    expect((await h.t.api.put('/api/umzug/connections/airtable', { token: 'patfalsch' })).status).toBe(400);
    expect((await h.t.api.put('/api/umzug/connections/airtable', { ...creds, base_id: 'quatsch' })).status).toBe(400);
    expect((await h.t.api.put('/api/umzug/connections/airtable', { ...creds, base_id: 'appFremd1234567' })).status).toBe(400);
    const r = await h.t.api.put('/api/umzug/connections/airtable', creds);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ account: 'at-usrFAKE1', label: 'chef@muster.example.com (2 Bases)' });
    expect(JSON.stringify(r.data)).not.toContain(AIRTABLE_TOKEN);
    expect(fake.requests.every((q) => q.url.hostname === 'api.airtable.com')).toBe(true);
  });
  it('counts bases (without the locked one), tables and records', async () => {
    const r = await h.t.api.post('/api/umzug/preview', { source: 'airtable', parts: ['objects'] });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const total = (k: string) => r.data.counts.find((c: any) => c.key === k)?.total;
    expect(total('bases')).toBe(2);
    expect(total('tables')).toBe(3);
    expect(total('records')).toBe(6);
    expect(r.data.warnings.join(' ')).toContain('30 Sekunden');
  });
});

describe('Airtable: import', () => {
  it('a dry run writes nothing', async () => {
    const job = await h.run({ source: 'airtable', parts: ['objects'] }, 'dry-run');
    expect(job.status, job.error).toBe('done');
    expect(h.count('object_types')).toBe(0);
    expect(h.lines(job).object_types.created).toBe(3);
    expect(h.lines(job).object_records.created).toBe(6);
  });

  it('imports every table as an object (named with its base when there are several)', async () => {
    imported = await h.run({ source: 'airtable', parts: ['objects'] });
    expect(imported.status, imported.error).toBe('done');
    const t = objectType('CRM › Kunden')!;
    expect(t).toBeTruthy();
    expect(objectType('CRM › Projekte')).toBeTruthy();
    expect(objectType('Projekte › Aufgaben')).toBeTruthy();
    const defs = h.q('SELECT key, label, type, options FROM object_properties WHERE location_id = ? AND object_key = ? ORDER BY position', t.key);
    expect(defs.map((d: any) => [d.key, d.type])).toEqual([['name', 'text'], ['e_mail', 'email'], ['telefon', 'phone'], ['branche', 'select'], ['tags', 'multiselect'], ['umsatz', 'currency'], ['quote', 'number'], ['bewertung', 'number'], ['dauer', 'text'], ['aktiv', 'checkbox'], ['kunde_seit', 'date'], ['angelegt', 'datetime'], ['betreuer', 'text'], ['dateien', 'text'], ['anrede', 'text'], ['projektsumme', 'number'], ['projektnamen', 'text'], ['nr', 'number'], ['notiz', 'textarea'], ['webseite', 'url']]);
    expect(JSON.parse(defs.find((d: any) => d.key === 'branche').options)).toEqual(['IT', 'Handel']);
    expect(defs.find((d: any) => d.key === 'name').label).toBe('Name');
    expect(imported.warnings.join(' ')).toContain('Anhänge werden nicht kopiert');
    expect(imported.warnings.join(' ')).toContain('Aktion (button)');
  });

  it('imports the records with their values, creation time and display name', () => {
    const t = objectType('CRM › Kunden')!;
    const recs = records(t.key);
    expect(recs).toHaveLength(3);
    expect(recs[0].properties).toMatchObject({ name: 'Muster GmbH', e_mail: 'info@muster.example.com', telefon: '+49301234567', branche: 'IT', umsatz: 12000.5, quote: 12.5, bewertung: 4, dauer: '1:30:00', aktiv: true, kunde_seit: '2020-03-01', betreuer: 'Anna Alt', dateien: 'vertrag.pdf', anrede: 'Sehr geehrte Frau Muster', projektsumme: 5800, projektnamen: 'Relaunch, Kampagne', nr: 1, notiz: 'Zeile 1\nZeile 2', webseite: 'https://muster.example.com' });
    // a tag Airtable does not list as a choice becomes a choice instead of being lost
    expect(recs[0].properties.tags).toEqual(['vip', 'neu', 'unbekannt']);
    expect(JSON.parse(h.one('SELECT options FROM object_properties WHERE location_id = ? AND object_key = ? AND key = ?', t.key, 'tags').options)).toEqual(['vip', 'neu', 'unbekannt']);
    expect(recs[0].created_at).toBe('2024-01-10T08:00:00.000Z');
    expect(recs[0].display).toBe('Muster GmbH');
    // an invalid e-mail is left out and noted, the record stays
    expect(recs[1].properties.e_mail).toBeUndefined();
    expect(recs[1].properties.name).toBe('Beispiel AG');
    expect(imported.warnings.join(' ')).toContain('passt nicht zum Typ');
    // a record without any value still exists
    expect(recs[2].display).toBe('');
    expect(records(objectType('CRM › Projekte')!.key)[0].properties).toMatchObject({ name: 'Relaunch', budget: 5000, start: '2024-03-01T09:30:00.000Z' });
  });

  it('turns linked records into links (each pair once, although both sides name it)', () => {
    const k = objectType('CRM › Kunden')!.key;
    const p = objectType('CRM › Projekte')!.key;
    const k1 = records(k)[0];
    expect(h.t.app.services.associations.list(h.loc(), { type: k, id: k1.id }, { type: p }).map((l: any) => l.name).sort()).toEqual(['Kampagne', 'Relaunch']);
    expect(h.count('associations')).toBe(3);
    expect(h.lines(imported).object_links).toMatchObject({ created: 3, updated: 3 });
  });

  it('a second run creates nothing twice', async () => {
    const again = await h.run({ source: 'airtable', parts: ['objects'] });
    expect(again.status, again.error).toBe('done');
    const l = h.lines(again);
    expect(l.object_types).toMatchObject({ created: 0, updated: 3 });
    expect(l.object_records).toMatchObject({ created: 0, updated: 6 });
    expect(l.object_links.created).toBe(0);
    expect(h.count('object_records')).toBe(6);
    expect(h.count('associations')).toBe(3);
  });

  it('a record somebody has changed since stays as they left it', async () => {
    const k = objectType('CRM › Kunden')!.key;
    const k1 = records(k)[0];
    h.t.app.services.customObjects.update(h.loc(), k, k1.id, { properties: { notiz: 'Meine Notiz' } }, { quiet: true });
    h.t.app.db.update('object_records', k1.id, { updated_at: new Date(Date.now() + 5000).toISOString() });
    const again = await h.run({ source: 'airtable', parts: ['objects'] });
    expect(h.lines(again).object_records.skipped).toBe(1);
    expect(records(k)[0].properties.notiz).toBe('Meine Notiz');
  });

  it('after a 429 the first retry waits the 30 seconds Airtable asks for; the token is never logged', async () => {
    const sleeps: number[] = [];
    h.t.app.services.umzugSleep = async (ms: number) => void sleeps.push(ms);
    fake.bare429 = 2;
    const job = await h.run({ source: 'airtable', parts: ['objects'] }, 'dry-run');
    h.t.app.services.umzugSleep = async () => undefined;
    expect(job.status, job.error).toBe('done');
    expect(sleeps.filter((s) => s === 30_000)).toHaveLength(1);
    expect(sleeps.filter((s) => s === 60_000)).toHaveLength(1);
    expect(JSON.stringify(h.t.app.db.all('SELECT log, warnings, progress, result FROM umzug_jobs'))).not.toContain(AIRTABLE_TOKEN);
  });

  it('a base id limits what is read; tables imported before are updated, not doubled', async () => {
    const r = await h.t.api.put('/api/umzug/connections/airtable', { ...creds, base_id: 'https://airtable.com/appBase2/tblAufgaben' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const p = await h.t.api.post('/api/umzug/preview', { source: 'airtable', parts: ['objects'] });
    expect(p.data.counts.find((c: any) => c.key === 'tables').total).toBe(1);
    const job = await h.run({ source: 'airtable', parts: ['objects'] });
    expect(job.status, job.error).toBe('done');
    expect(h.lines(job).object_types).toMatchObject({ created: 0, updated: 1 });
    expect(h.count('object_types')).toBe(3);
    // the select without choices became text
    expect(h.one('SELECT type FROM object_properties WHERE location_id = ? AND object_key = ? AND label = ?', objectType('Projekte › Aufgaben')!.key, 'Stand').type).toBe('text');
  });
});

describe('Airtable: undo', () => {
  it('removes records (with their links), objects and properties', async () => {
    const job = await h.undo(imported.id);
    expect(job.undo.deleted).toMatchObject({ object_types: 3, object_records: 6 });
    expect(h.count('object_records')).toBe(0);
    expect(h.count('associations')).toBe(0);
    expect(h.count('object_types')).toBe(0);
    expect(h.count('object_properties')).toBe(0);
  });

  it('keeps an object that has records of its own', async () => {
    expect((await h.t.api.put('/api/umzug/connections/airtable', creds)).status).toBe(200);
    const again = await h.run({ source: 'airtable', parts: ['objects'] });
    expect(again.status, again.error).toBe('done');
    const k = objectType('CRM › Kunden')!;
    h.t.app.services.customObjects.upsert(h.loc(), k.key, { properties: { name: 'Eigener Kunde' } }, { quiet: true });
    const undone = await h.undo(again.id);
    expect(undone.undo.kept).toMatchObject({ object_types: 1 });
    expect(undone.undo.notes.join(' ')).toContain('Ein eigenes Objekt bleibt');
    expect(objectType('CRM › Kunden')).toBeTruthy();
    expect(records(k.key)).toHaveLength(1);
  });
});
