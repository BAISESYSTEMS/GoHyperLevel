import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { coerceValue, cleanPropertyDef, companyDomain, filterSql, isFreeMail, validateProps, ValueError } from '../server/services/objects.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
const flush = () => t.app.events.flush();
const db = () => t.app.db;

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
});
afterAll(async () => {
  await t.close();
});

describe('property types (pure)', () => {
  const def = (type: any, options: string[] = []) => ({ label: 'Feld', type, options });
  it('checks and normalises every type', () => {
    expect(coerceValue(def('text'), '  Hallo ')).toBe('Hallo');
    expect(coerceValue(def('number'), '1.234,5')).toBe(1234.5);
    expect(coerceValue(def('currency'), '19,999')).toBe(20);
    expect(coerceValue(def('date'), '03.10.2026')).toBe('2026-10-03');
    expect(coerceValue(def('datetime'), '2026-10-03T08:30:00Z')).toBe('2026-10-03T08:30:00.000Z');
    expect(coerceValue(def('select', ['Rot', 'Blau']), 'rot')).toBe('Rot');
    expect(coerceValue(def('multiselect', ['A', 'B', 'C']), 'a, c, a')).toEqual(['A', 'C']);
    expect(coerceValue(def('checkbox'), 'ja')).toBe(true);
    expect(coerceValue(def('checkbox'), false)).toBe(false);
    expect(coerceValue(def('url'), 'acme.de/x')).toBe('https://acme.de/x');
    expect(coerceValue(def('email'), ' Anna@Acme.DE ')).toBe('anna@acme.de');
    expect(coerceValue(def('phone'), '0170 1234567')).toBe('+491701234567');
    expect(coerceValue(def('text'), '')).toBeNull();
    for (const [type, v] of [['number', 'abc'], ['date', '31.31.2026'], ['select', 'Grün'], ['email', 'nope'], ['url', 'javascript:alert(1)'], ['checkbox', 'vielleicht'], ['phone', '12']] as const) {
      expect(() => coerceValue(def(type, ['Rot']), v), `${type} ${v}`).toThrow(ValueError);
    }
  });
  it('validates definitions, required and unknown keys', () => {
    expect(() => cleanPropertyDef({ label: 'Farbe', type: 'select' })).toThrow(/Option/);
    expect(cleanPropertyDef({ label: 'Erstzulassung am', type: 'date' }).key).toBe('erstzulassung_am');
    expect(cleanPropertyDef({ label: 'Notizen', type: 'textarea', unique: true }).unique).toBe(false);
    expect(() => cleanPropertyDef({ label: 'X', type: 'magic' })).toThrow(/Typ/);
    const defs = [cleanPropertyDef({ label: 'Kennzeichen', required: true }), cleanPropertyDef({ label: 'km', type: 'number' })];
    expect(() => validateProps(defs, { km: 5 })).toThrow(/Pflichtfeld/);
    expect(validateProps(defs, { km: '7' }, { partial: true })).toEqual({ km: 7 });
    expect(() => validateProps(defs, { kennzeichen: '' }, { partial: true })).toThrow(/Pflichtfeld/);
    expect(() => validateProps(defs, { farbe: 'rot' }, { partial: true })).toThrow(/Unbekannte/);
  });
  it('builds filters and knows free-mail domains', () => {
    const f = filterSql([{ field: 'km', op: 'gt', value: '100' }, { field: 'tags', op: 'contains', value: 'a,b' }], (x) => (x === 'km' ? { sql: 'k', type: 'number' } : x === 'tags' ? { sql: 't', type: 'multiselect' } : undefined));
    expect(f.where[0]).toBe('CAST(k AS REAL) > ?');
    expect(f.params).toEqual([100, 'a', 'b']);
    expect(() => filterSql([{ field: 'x', op: 'eq', value: 1 }], () => undefined)).toThrow(/unbekanntes Feld/);
    expect(companyDomain('https://www.Acme.de/kontakt?x=1')).toBe('acme.de');
    expect(companyDomain('anna@shop.acme.de')).toBe('shop.acme.de');
    expect(companyDomain('kein domain')).toBe('');
    expect(isFreeMail('gmx.de')).toBe(true);
    expect(isFreeMail('acme.de')).toBe(false);
  });
});

describe('companies', () => {
  let acme: any;
  it('creates, dedupes by domain and lists with filters', async () => {
    const r = await t.api.post('/api/companies', { name: 'ACME GmbH', domain: 'https://www.acme.de', industry: 'Software', size: '25', lifecycle_stage: 'Lead', phone: '030 123456' });
    expect(r.status).toBe(200);
    acme = r.data;
    expect(acme).toMatchObject({ name: 'ACME GmbH', domain: 'acme.de', size: '11-50', lifecycle_stage: 'lead', phone: '+4930123456', created: true });
    const again = await t.api.post('/api/companies', { name: 'Acme', domain: 'acme.de', city: 'Berlin' });
    expect(again.data).toMatchObject({ id: acme.id, created: false, name: 'Acme', city: 'Berlin' });
    expect((await t.api.post('/api/companies', { name: 'Ohne', size: 'riesig' })).status).toBe(400);
    expect((await t.api.post('/api/companies', { name: 'Kaputt', domain: 'no domain' })).data.error).toMatch(/Domain/);
    await t.api.post('/api/companies', { name: 'Bäckerei Krume', industry: 'Handwerk', domain: 'krume.de' });
    const list = await t.api.get(`/api/companies?filters=${encodeURIComponent(JSON.stringify([{ field: 'industry', op: 'eq', value: 'software' }]))}`);
    expect(list.data.total).toBe(1);
    expect(list.data.companies[0].id).toBe(acme.id);
    const sorted = await t.api.get('/api/companies?sort=name');
    expect(sorted.data.companies.map((c: any) => c.name)).toEqual(['Acme', 'Bäckerei Krume']);
    expect((await t.api.patch(`/api/companies/${acme.id}`, { domain: 'krume.de' })).status).toBe(409);
  });

  it('custom properties with validation and unique', async () => {
    const p = await t.api.post('/api/properties', { object: 'company', label: 'Kundennummer', type: 'text', unique: true });
    expect(p.status).toBe(200);
    await t.api.post('/api/properties', { object: 'company', label: 'Tier', type: 'select', options: ['A', 'B', 'C'] });
    const r = await t.api.patch(`/api/companies/${acme.id}`, { custom: { kundennummer: 'K-1', tier: 'a' } });
    expect(r.data.custom).toEqual({ kundennummer: 'K-1', tier: 'A' });
    const other = (await t.api.get('/api/companies?q=Krume')).data.companies[0];
    expect((await t.api.patch(`/api/companies/${other.id}`, { custom: { kundennummer: 'K-1' } })).data.error).toMatch(/eindeutig/);
    expect((await t.api.patch(`/api/companies/${other.id}`, { custom: { tier: 'Z' } })).data.error).toMatch(/keine Option/);
    expect((await t.api.patch(`/api/companies/${other.id}`, { custom: { unbekannt: 1 } })).data.error).toMatch(/Unbekannte/);
    const f = await t.api.get(`/api/companies?filters=${encodeURIComponent(JSON.stringify([{ field: 'custom.tier', op: 'eq', value: 'A' }]))}`);
    expect(f.data.companies.map((c: any) => c.id)).toEqual([acme.id]);
  });

  it('auto-associates contacts by e-mail domain (not free mail) and keeps contacts.company in sync', async () => {
    const anna = (await t.api.post('/api/contacts', { first_name: 'Anna', email: 'anna@acme.de' })).data;
    const ben = (await t.api.post('/api/contacts', { first_name: 'Ben', email: 'ben@gmx.de' })).data;
    await flush();
    const links = (await t.api.get(`/api/associations?type=contact&id=${anna.id}&to_type=company`)).data;
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ record_id: acme.id, primary: true, primary_for: anna.id });
    expect((await t.api.get(`/api/contacts/${anna.id}`)).data.company).toBe('Acme');
    expect((await t.api.get(`/api/associations?type=contact&id=${ben.id}`)).data).toHaveLength(0);

    // A new company domain picks up existing contacts.
    const carl = (await t.api.post('/api/contacts', { first_name: 'Carl', email: 'carl@zeta.io' })).data;
    await flush();
    const zeta = (await t.api.post('/api/companies', { name: 'Zeta', domain: 'zeta.io' })).data;
    expect((await t.api.get(`/api/contacts/${carl.id}`)).data.company).toBe('Zeta');

    // Renaming the company renames the contacts' text.
    await t.api.patch(`/api/companies/${zeta.id}`, { name: 'Zeta AG' });
    expect((await t.api.get(`/api/contacts/${carl.id}`)).data.company).toBe('Zeta AG');

    // Typing a company name on a contact picks or creates the company and makes it primary.
    await t.api.patch(`/api/contacts/${ben.id}`, { company: 'Neue Firma KG' });
    await flush();
    const created = (await t.api.get('/api/companies?q=Neue')).data.companies[0];
    expect(created).toMatchObject({ name: 'Neue Firma KG', source: 'Kontakt' });
    const benLinks = (await t.api.get(`/api/associations?type=contact&id=${ben.id}&to_type=company`)).data;
    expect(benLinks.map((l: any) => [l.record_id, l.primary])).toEqual([[created.id, true]]);

    // A second company: switching primary updates the text, the old link stays.
    const link = await t.api.post('/api/associations', { from_type: 'contact', from_id: ben.id, to_type: 'company', to_id: acme.id, primary: true });
    expect(link.status).toBe(200);
    expect((await t.api.get(`/api/contacts/${ben.id}`)).data.company).toBe('Acme');
    // Removing the primary link promotes the remaining company.
    const acmeLink = (await t.api.get(`/api/associations?type=contact&id=${ben.id}&to_type=company`)).data.find((l: any) => l.record_id === acme.id);
    await t.api.del(`/api/associations/${acmeLink.association_id}`);
    expect((await t.api.get(`/api/contacts/${ben.id}`)).data.company).toBe('Neue Firma KG');

    // Contacts changed without events (CSV import) are caught up by the scheduler.
    await t.api.post('/api/contacts/import', { csv: 'Vorname,E-Mail,Firma\nDora,dora@example.org,Importfirma GmbH' });
    await t.app.tick();
    expect((await t.api.get('/api/companies?q=Importfirma')).data.total).toBe(1);
  });

  it('settings: no auto-association when switched off', async () => {
    expect((await t.api.put('/api/companies/settings', { auto_associate: false })).data.auto_associate).toBe(false);
    const eve = (await t.api.post('/api/contacts', { first_name: 'Eve', email: 'eve@acme.de' })).data;
    await flush();
    expect((await t.api.get(`/api/associations?type=contact&id=${eve.id}`)).data).toHaveLength(0);
    await t.api.put('/api/companies/settings', { auto_associate: true, create_from_domain: true });
    const fritz = (await t.api.post('/api/contacts', { first_name: 'Fritz', email: 'fritz@mueller-bau.de' })).data;
    await flush();
    expect((await t.api.get(`/api/contacts/${fritz.id}`)).data.company).toBe('Mueller Bau');
    await t.api.put('/api/companies/settings', { create_from_domain: false });
  });

  it('company page: contacts, deals (auto-linked), timeline, notes, tasks', async () => {
    const pipe = (await t.api.get('/api/pipelines')).data[0];
    const anna = (await t.api.get('/api/contacts?q=anna@acme.de')).data.contacts[0];
    const opp = (await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: anna.id, name: 'Lizenz', value: 5000 })).data;
    await flush();
    await t.api.post(`/api/contacts/${anna.id}/notes`, { body: 'Kontakt-Notiz' });
    expect((await t.api.post(`/api/companies/${acme.id}/notes`, { body: 'Rahmenvertrag besprochen' })).status).toBe(200);
    const task = (await t.api.post(`/api/companies/${acme.id}/tasks`, { title: 'Angebot schicken' })).data;
    const page = (await t.api.get(`/api/companies/${acme.id}`)).data;
    expect(page.contacts.map((c: any) => c.record_id)).toContain(anna.id);
    expect(page.deals.map((d: any) => [d.record_id, d.value])).toEqual([[opp.id, 5000]]);
    expect(page.deals_value).toBe(5000);
    expect(page.notes[0].body).toBe('Rahmenvertrag besprochen');
    expect(page.tasks.map((x: any) => x.id)).toEqual([task.id]);
    const kinds = new Set(page.timeline.map((x: any) => x.kind));
    expect(kinds).toEqual(new Set(['company', 'contact', 'note']));
    expect(page.timeline.some((x: any) => x.summary.includes('Tier'))).toBe(true);
    // The global task list shows the company task; deleting it removes the link.
    expect((await t.api.get('/api/tasks')).data.some((x: any) => x.id === task.id)).toBe(true);
    await t.api.del(`/api/tasks/${task.id}`);
    expect((await t.api.get(`/api/companies/${acme.id}`)).data.tasks).toHaveLength(0);
  });

  it('CSV export and import with dedupe', async () => {
    const csv = await t.api.get('/api/companies/export.csv');
    expect(csv.data).toContain('name,domain,industry');
    expect(csv.data).toContain('acme.de');
    const imp = await t.api.post('/api/companies/import', { csv: 'Firmenname;Domain;Branche;Tier\nAcme Neu;acme.de;Software;B\nOmega GmbH;omega.de;Handel;C\nOhne Domain;;;\nKaputt;x;;Z' });
    expect(imp.data).toMatchObject({ created: 2, updated: 1, skipped: 1 });
    expect(imp.data.errors[0]).toMatchObject({ row: 5 });
    expect((await t.api.get(`/api/companies/${acme.id}`)).data).toMatchObject({ name: 'Acme Neu', custom: { tier: 'B', kundennummer: 'K-1' } });
    const again = await t.api.post('/api/companies/import', { csv: 'Name\nOhne Domain' });
    expect(again.data).toMatchObject({ created: 0, updated: 1 });
  });

  it('merges duplicates and filters contacts by company properties', async () => {
    const a = (await t.api.post('/api/companies', { name: 'Doppel' })).data;
    const b = (await t.api.post('/api/companies', { name: 'Doppel', domain: 'doppel.de', industry: 'Beratung' })).data;
    const gina = (await t.api.post('/api/contacts', { first_name: 'Gina', email: 'gina@doppel.de' })).data;
    await flush();
    expect((await t.api.get('/api/companies/duplicates')).data.some((g: any) => g.key === 'doppel')).toBe(true);
    const merged = (await t.api.post(`/api/companies/${a.id}/merge`, { from_id: b.id })).data;
    expect(merged).toMatchObject({ id: a.id, domain: 'doppel.de', industry: 'Beratung' });
    expect((await t.api.get(`/api/companies/${b.id}`)).status).toBe(404);
    expect((await t.api.get(`/api/contacts/${gina.id}`)).data.company).toBe('Doppel');

    const bySoftware = (await t.api.get('/api/contacts?company.industry=Software')).data.contacts.map((c: any) => c.first_name);
    expect(bySoftware).toContain('Anna');
    expect(bySoftware).not.toContain('Gina');
    expect((await t.api.get(`/api/contacts?company.custom.tier=B`)).data.contacts.map((c: any) => c.first_name)).toContain('Anna');
    expect((await t.api.get(`/api/contacts?company.id=${a.id}`)).data.contacts.map((c: any) => c.first_name)).toEqual(['Gina']);
    // Smart lists (campaign audiences) use the same filter.
    const sl = (await t.api.post('/api/smart-lists', { name: 'Software-Kunden', filter: { 'company.industry': 'Software' } })).data;
    const camp = (await t.api.post('/api/campaigns', { name: 'Info', channel: 'email', subject: 'Hi', body: 'Hallo', filter: { smart_list_id: sl.id } })).data;
    expect(camp.id).toBeTruthy();
  });

  it('deleting a company clears the contacts text and its associations', async () => {
    const co = (await t.api.post('/api/companies', { name: 'Weg GmbH' })).data;
    const hans = (await t.api.post('/api/contacts', { first_name: 'Hans', company: 'Weg GmbH' })).data;
    await flush();
    expect((await t.api.get(`/api/associations?type=company&id=${co.id}`)).data).toHaveLength(1);
    await t.api.del(`/api/companies/${co.id}`);
    expect((await t.api.get(`/api/contacts/${hans.id}`)).data.company).toBe('');
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM associations WHERE a_id = ? OR b_id = ?', co.id, co.id)!.n).toBe(0);
  });
});

describe('custom objects', () => {
  let car: any;
  let vw: any;
  it('defines an object type with typed properties', async () => {
    const r = await t.api.post('/api/object-types', { singular: 'Fahrzeug', plural: 'Fahrzeuge', icon: 'deal', primary_label: 'Kennzeichen', primary_unique: true });
    expect(r.status).toBe(200);
    car = r.data;
    expect(car).toMatchObject({ key: 'p_fahrzeuge', primary_property: 'name' });
    expect(car.properties[0]).toMatchObject({ key: 'name', label: 'Kennzeichen', required: true, unique: true });
    for (const p of [
      { label: 'Marke', type: 'select', options: ['VW', 'BMW', 'Tesla'], required: true },
      { label: 'Kilometer', type: 'number' },
      { label: 'Preis', type: 'currency' },
      { label: 'Erstzulassung', type: 'date' },
      { label: 'Extras', type: 'multiselect', options: ['Klima', 'Navi', 'AHK'] },
      { label: 'Elektro', type: 'checkbox' },
      { label: 'Datenblatt', type: 'url' },
    ]) {
      const x = await t.api.post('/api/properties', { object: car.key, ...p });
      expect(x.status, JSON.stringify(x.data)).toBe(200);
    }
    expect((await t.api.post('/api/properties', { object: car.key, label: 'created_at' })).data.error).toMatch(/reserviert/);
    expect((await t.api.post('/api/properties', { object: 'p_gibtsnicht', label: 'X' })).data.error).toMatch(/Unbekanntes Objekt/);
    expect((await t.api.post('/api/object-types', { singular: 'Fahrzeug', plural: 'Fahrzeuge' })).status).toBe(400);
    const objs = (await t.api.get('/api/objects')).data;
    expect(objs[0].properties).toHaveLength(8);
  });

  it('records CRUD with validation, unique upsert and filters', async () => {
    const base = `/api/objects/${car.key}/records`;
    expect((await t.api.post(base, { properties: { marke: 'VW' } })).data.error).toMatch(/Kennzeichen.*Pflichtfeld/);
    expect((await t.api.post(base, { properties: { name: 'B-XY 1', marke: 'Opel' } })).data.error).toMatch(/keine Option/);
    vw = (await t.api.post(base, { properties: { name: 'B-XY 1', marke: 'vw', kilometer: '120.000', preis: '12.500,00', erstzulassung: '01.02.2020', extras: 'Klima, Navi', elektro: 'nein' } })).data;
    expect(vw).toMatchObject({ created: true, display: 'B-XY 1', properties: { marke: 'VW', kilometer: 120000, preis: 12500, erstzulassung: '2020-02-01', extras: ['Klima', 'Navi'], elektro: false } });
    await t.api.post(base, { properties: { name: 'M-EL 9', marke: 'Tesla', kilometer: 8000, elektro: true, extras: ['Navi'] } });
    await t.api.post(base, { properties: { name: 'HH-A 2', marke: 'BMW', kilometer: 64000, extras: ['AHK'] } });
    // Same unique value → update instead of a duplicate.
    const up = (await t.api.post(base, { properties: { name: 'b-xy 1', kilometer: 121000 } })).data;
    expect(up).toMatchObject({ id: vw.id, created: false, properties: { kilometer: 121000, marke: 'VW' } });
    expect((await t.api.patch(`${base}/${vw.id}`, { properties: { name: 'M-EL 9' } })).data.error).toMatch(/eindeutig/);

    const q = (filters: any[], sort = '') => t.api.get(`${base}?filters=${encodeURIComponent(JSON.stringify(filters))}&sort=${sort}`).then((r) => r.data);
    expect((await q([{ field: 'kilometer', op: 'gt', value: 50000 }], 'kilometer')).records.map((r: any) => r.display)).toEqual(['HH-A 2', 'B-XY 1']);
    expect((await q([{ field: 'extras', op: 'contains', value: 'Navi' }], '-display')).records.map((r: any) => r.display)).toEqual(['M-EL 9', 'B-XY 1']);
    expect((await q([{ field: 'elektro', op: 'eq', value: true }])).records.map((r: any) => r.display)).toEqual(['M-EL 9']);
    expect((await q([{ field: 'marke', op: 'in', value: 'bmw,tesla' }])).total).toBe(2);
    expect((await q([{ field: 'preis', op: 'empty' }])).total).toBe(2);
    expect((await t.api.get(`${base}?filters=${encodeURIComponent('[{"field":"farbe","op":"eq","value":1}]')}`)).status).toBe(400);
    expect((await t.api.get(`${base}?q=HH-A`)).data.total).toBe(1);

    const page = (await t.api.get(`${base}/${vw.id}`)).data;
    expect(page.activities.map((a: any) => a.type)).toEqual(['record.updated', 'record.created']);
    expect(page.activities[0].summary).toContain('Kilometer: 120000 → 121000');
    await t.api.post(`${base}/${vw.id}/notes`, { body: 'TÜV fällig' });
    expect((await t.api.get(`${base}/${vw.id}`)).data.notes[0].body).toBe('TÜV fällig');
  });

  it('changing the display property and saved views per user', async () => {
    const t2 = (await t.api.patch(`/api/object-types/${car.id}`, { primary_property: 'marke' })).status;
    expect(t2).toBe(400); // select is no display property
    await t.api.patch(`/api/object-types/${car.id}`, { primary_property: 'name', plural: 'Autos' });
    const v = (await t.api.post('/api/object-views', { object: car.key, name: 'Elektro', config: { columns: ['name', 'kilometer'], filters: [{ field: 'elektro', op: 'eq', value: true }], sort: '-kilometer' } })).data;
    expect(v).toMatchObject({ mine: true, shared: false, config: { sort: '-kilometer' } });
    expect((await t.api.get(`/api/object-views?object=${car.key}`)).data).toHaveLength(1);
    const key = (await t.api.post('/api/api-keys', { name: 'k' })).data.key;
    const viaKey = await t.api.raw(`/api/object-views?object=${car.key}`, { headers: { authorization: `Bearer ${key}` } }).then((r) => r.json());
    expect(viaKey).toHaveLength(0);
  });

  it('CSV import with dedupe and errors, export', async () => {
    const r = await t.api.post(`/api/objects/${car.key}/import`, { csv: 'Kennzeichen,Marke,Kilometer\nK-AB 3,BMW,1000\nB-XY 1,VW,130000\nK-ZZ 4,Fiat,5' });
    expect(r.data).toMatchObject({ created: 1, updated: 1, skipped: 1 });
    expect(r.data.errors[0].error).toMatch(/keine Option/);
    const csv = (await t.api.get(`/api/objects/${car.key}/export.csv`)).data;
    expect(csv).toContain('Kennzeichen,Marke');
    expect(csv).toContain('K-AB 3');
  });
});

describe('associations', () => {
  it('links any records with labels, refuses unknown ones and cascades on delete', async () => {
    const car = (await t.api.get('/api/objects')).data[0];
    const rec = (await t.api.get(`/api/objects/${car.key}/records?q=M-EL`)).data.records[0];
    const anna = (await t.api.get('/api/contacts?q=anna@acme.de')).data.contacts[0];
    const acme = (await t.api.get('/api/companies?q=acme.de')).data.companies[0];
    expect((await t.api.post('/api/association-labels', { a_type: 'contact', b_type: car.key, name: 'Halter' })).status).toBe(200);
    await t.api.post('/api/association-labels', { a_type: 'company', b_type: 'contact', name: 'Entscheider' });
    await t.api.post('/api/association-labels', { a_type: 'contact', b_type: 'company', name: 'Rechnungsempfänger' });
    expect((await t.api.post('/api/association-labels', { a_type: 'company', b_type: 'contact', name: 'entscheider' })).status).toBe(400);

    const l = await t.api.post('/api/associations', { from_type: car.key, from_id: rec.id, to_type: 'contact', to_id: anna.id, labels: ['Halter'] });
    expect(l.status).toBe(200);
    expect((await t.api.post('/api/associations', { from_type: car.key, from_id: rec.id, to_type: 'contact', to_id: anna.id, labels: ['Entscheider'] })).data.error).toMatch(/Unbekanntes Label/);
    await t.api.post('/api/associations', { from_type: 'contact', from_id: anna.id, to_type: car.key, to_id: rec.id }); // idempotent
    await t.api.post('/api/associations', { from_type: car.key, from_id: rec.id, to_type: 'company', to_id: acme.id });
    const annaCo = (await t.api.get(`/api/associations?type=contact&id=${anna.id}&to_type=company`)).data[0];
    const patched = await t.api.patch(`/api/associations/${annaCo.association_id}`, { labels: ['Entscheider', 'Rechnungsempfänger'] });
    expect(patched.data.labels).toHaveLength(2);
    const decision = (await t.api.get(`/api/associations?type=company&id=${acme.id}&label=Entscheider`)).data;
    expect(decision.map((x: any) => x.record_id)).toEqual([anna.id]);
    const fromAnna = (await t.api.get(`/api/associations?type=contact&id=${anna.id}`)).data;
    expect(fromAnna.find((x: any) => x.type === car.key)).toMatchObject({ record_id: rec.id, labels: [{ name: 'Halter' }], link: `objects/${car.key}/${rec.id}` });
    expect((await t.api.post('/api/associations', { from_type: 'contact', from_id: anna.id, to_type: 'contact', to_id: anna.id })).status).toBe(400);
    expect((await t.api.post('/api/associations', { from_type: 'contact', from_id: anna.id, to_type: 'raumschiff', to_id: 'x' })).data.error).toMatch(/Unbekannter Objekttyp/);
    const types = (await t.api.get('/api/associations/types')).data.map((x: any) => x.type);
    expect(types).toEqual(expect.arrayContaining(['contact', 'company', 'opportunity', 'task', 'ticket', car.key]));
    expect((await t.api.get(`/api/associations/search?type=company&q=acm`)).data[0].id).toBe(acme.id);

    // Deleting a label drops it from every association.
    const halter = (await t.api.get(`/api/association-labels?a_type=contact&b_type=${car.key}`)).data[0];
    await t.api.del(`/api/association-labels/${halter.id}`);
    expect((await t.api.get(`/api/associations?type=contact&id=${anna.id}&to_type=${car.key}`)).data[0].labels).toEqual([]);

    // Cascades: record, contact, deal deleted → their links are gone.
    await t.api.del(`/api/objects/${car.key}/records/${rec.id}`);
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM associations WHERE a_id = ? OR b_id = ?', rec.id, rec.id)!.n).toBe(0);
    const tmp = (await t.api.post('/api/contacts', { first_name: 'Temp', email: 'temp@acme.de' })).data;
    await flush();
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM associations WHERE a_id = ? OR b_id = ?', tmp.id, tmp.id)!.n).toBe(1);
    await t.api.del(`/api/contacts/${tmp.id}`);
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM associations WHERE a_id = ? OR b_id = ?', tmp.id, tmp.id)!.n).toBe(0);
    const opp = db().get('SELECT o.id FROM opportunities o WHERE o.name = ?', 'Lizenz')!;
    await t.api.del(`/api/opportunities/${opp.id}`);
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM associations WHERE a_id = ? OR b_id = ?', opp.id, opp.id)!.n).toBe(0);
  });

  it('other modules can register their own types (e.g. tickets)', async () => {
    db().raw.exec(`CREATE TABLE IF NOT EXISTS test_tickets (id TEXT PRIMARY KEY, location_id TEXT, subject TEXT)`);
    const A = t.app.services.associations;
    A.registerType({ type: 'ticket', label: 'Ticket', plural: 'Tickets', table: 'test_tickets', get: (loc: string, rid: string) => { const r = db().get('SELECT * FROM test_tickets WHERE id = ? AND location_id = ?', rid, loc); return r ? { id: r.id, name: r.subject } : undefined; } });
    expect(() => A.registerType({ type: 'p_nope', label: 'x', plural: 'x', get: () => undefined })).toThrow();
    db().run('INSERT INTO test_tickets VALUES (?, ?, ?)', 'tk1', t.api.location, 'Drucker kaputt');
    const acme = (await t.api.get('/api/companies?q=acme.de')).data.companies[0];
    expect((await t.api.post('/api/associations', { from_type: 'ticket', from_id: 'tk1', to_type: 'company', to_id: acme.id })).status).toBe(200);
    expect((await t.api.get(`/api/associations?type=company&id=${acme.id}&to_type=ticket`)).data[0].name).toBe('Drucker kaputt');
    db().run('DELETE FROM test_tickets WHERE id = ?', 'tk1');
    expect((await t.api.get(`/api/associations?type=company&id=${acme.id}&to_type=ticket`)).data).toHaveLength(0);
  });
});

describe('properties page', () => {
  it('manages groups and properties for contacts, companies, deals and custom objects', async () => {
    const g = (await t.api.post('/api/property-groups', { object: 'contact', label: 'Vertrieb' })).data;
    const f = (await t.api.post('/api/properties', { object: 'contact', label: 'Budget', type: 'number', group_key: g.key, description: 'Jahresbudget' })).data;
    expect(f).toMatchObject({ object_key: 'contact', key: 'budget' });
    // Still a normal custom field for the contact page and the old API.
    expect((await t.api.get('/api/custom-fields')).data.find((x: any) => x.key === 'budget')).toMatchObject({ group_key: 'vertrieb', description: 'Jahresbudget' });
    expect((await t.api.post('/api/properties', { object: 'contact', label: 'Farben', type: 'multiselect', options: ['a'] })).data.error).toMatch(/Typ/);
    expect((await t.api.post('/api/properties', { object: 'contact', label: 'Groups', group_key: 'gibtsnicht' })).data.error).toMatch(/Gruppe/);
    const deal = (await t.api.post('/api/properties', { object: 'opportunity', label: 'Laufzeit (Monate)', type: 'number', required: false })).data;
    expect(deal.object_key).toBe('opportunity');
    const all = (await t.api.get('/api/properties')).data;
    expect(all.objects.map((o: any) => o.key)).toEqual(expect.arrayContaining(['contact', 'company', 'opportunity', 'p_fahrzeuge']));
    expect(all.standard.company.map((s: any) => s.key)).toContain('domain');
    expect(all.properties.filter((p: any) => p.object_key === 'company').map((p: any) => p.key)).toEqual(['kundennummer', 'tier']);
    // Rename/regroup, then delete the group: the property stays without group.
    await t.api.patch(`/api/properties/${f.id}`, { label: 'Budget (€)' });
    await t.api.del(`/api/property-groups/${g.id}`);
    expect((await t.api.get('/api/custom-fields')).data.find((x: any) => x.key === 'budget')).toMatchObject({ label: 'Budget (€)', group_key: '' });

    // Deal property values live next to the opportunity.
    const pipe = (await t.api.get('/api/pipelines')).data[0];
    const anna = (await t.api.get('/api/contacts?q=anna@acme.de')).data.contacts[0];
    const opp = (await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: anna.id, name: 'Wartung' })).data;
    expect((await t.api.put(`/api/opportunities/${opp.id}/properties`, { properties: { laufzeit_monate: '24' } })).data.properties).toEqual({ laufzeit_monate: 24 });
    expect((await t.api.put(`/api/opportunities/${opp.id}/properties`, { properties: { laufzeit_monate: 'lange' } })).status).toBe(400);
    // Deleting a property removes its values.
    await t.api.del(`/api/properties/${deal.id}`);
    expect((await t.api.get(`/api/opportunities/${opp.id}/properties`)).data.properties).toEqual({});
  });
});

describe('workflows with companies and custom objects', () => {
  it('runs for associated contacts on company/record triggers and creates, updates and links records', async () => {
    const meta = (await t.api.get('/api/workflows/meta')).data;
    expect(meta.triggers).toEqual(expect.arrayContaining(['company.created', 'company.property_changed', 'record.created', 'record.property_changed']));
    expect(meta.steps).toEqual(expect.arrayContaining(['create_record', 'update_record', 'associate_records']));
    const car = (await t.api.get('/api/objects')).data[0];
    const acme = (await t.api.get('/api/companies?q=acme.de')).data.companies[0];

    // Company property changed (lifecycle → customer) → tag the decision makers only.
    const wf1 = (await t.api.post('/api/workflows', { name: 'Kunde', trigger: { type: 'company.property_changed', config: { property: 'lifecycle_stage', value: 'customer', label: 'Entscheider' } }, steps: [{ type: 'add_tag', tags: ['kunde-entscheider'] }, { type: 'add_note', body: 'Firma {{event.company.name}} ist jetzt Kunde' }] })).data;
    await t.api.patch(`/api/workflows/${wf1.id}`, { status: 'active' });
    // Record created → create a company from a template and link it, set a record property.
    const wf2 = (await t.api.post('/api/workflows', {
      name: 'Neues Fahrzeug',
      trigger: { type: 'record.created', config: { object: car.key } },
      steps: [
        { type: 'update_record', object: car.key, target: 'trigger', properties: { kilometer: '1' } },
        { type: 'create_record', object: 'company', properties: { name: 'Halter von {{event.record.display}}', domain: 'halter-{{event.record.properties.marke}}.de', tier: 'C' }, label: 'Rechnungsempfänger' },
        { type: 'associate_records', object: 'company', target: 'match', property: 'domain', value: '{{contact.email}}' },
      ],
    })).data;
    await t.api.patch(`/api/workflows/${wf2.id}`, { status: 'active' });

    await t.api.patch(`/api/companies/${acme.id}`, { lifecycle_stage: 'customer' });
    await flush();
    const anna = (await t.api.get('/api/contacts?q=anna@acme.de')).data.contacts[0];
    expect(anna.tags).toContain('kunde-entscheider');
    const others = (await t.api.get(`/api/contacts?company.id=${acme.id}`)).data.contacts.filter((c: any) => c.id !== anna.id);
    expect(others.every((c: any) => !c.tags.includes('kunde-entscheider'))).toBe(true);

    // A record with an associated contact starts wf2 for that contact.
    const tom = (await t.api.post('/api/contacts', { first_name: 'Tom', email: 'tom@omega.de' })).data;
    await flush();
    const rec = (await t.api.post(`/api/objects/${car.key}/records`, { properties: { name: 'S-WF 1', marke: 'BMW' }, associations: [{ type: 'contact', id: tom.id }] })).data;
    await flush();
    expect((await t.api.get(`/api/objects/${car.key}/records/${rec.id}`)).data.properties.kilometer).toBe(1);
    const tomCos = (await t.api.get(`/api/associations?type=contact&id=${tom.id}&to_type=company`)).data;
    const names = tomCos.map((c: any) => c.name).sort();
    expect(names).toEqual(['Halter von S-WF 1', 'Omega GmbH']);
    expect(tomCos.find((c: any) => c.name === 'Halter von S-WF 1').labels.map((l: any) => l.name)).toEqual(['Rechnungsempfänger']);
    const halter = (await t.api.get('/api/companies?q=halter-bmw.de')).data.companies[0];
    expect(halter.custom.tier).toBe('C');
  });
});

describe('snapshots: object definitions and property schemas', () => {
  it('round-trips types, properties, groups and labels – never records', async () => {
    await t.api.post('/api/property-groups', { object: 'company', label: 'Finanzen' });
    const snap = (await t.api.post('/api/snapshots', { location_id: t.api.location, name: 'CRM-Vorlage' })).data;
    const r = (await t.api.post('/api/agency/clients', { name: 'Neukunde Objekte', snapshot_id: snap.id })).data;
    const dst = r.location.id;
    expect(r.created.object_types).toBe(1);
    expect(db().get('SELECT * FROM object_types WHERE location_id = ?', dst)).toMatchObject({ key: 'p_fahrzeuge', singular: 'Fahrzeug', plural: 'Autos' });
    const props = db().all('SELECT object_key, key, type, is_unique FROM object_properties WHERE location_id = ? ORDER BY object_key, position', dst);
    expect(props.filter((p) => p.object_key === 'p_fahrzeuge').map((p) => p.key)).toEqual(['name', 'marke', 'kilometer', 'preis', 'erstzulassung', 'extras', 'elektro', 'datenblatt']);
    expect(props.find((p) => p.key === 'kundennummer')).toMatchObject({ object_key: 'company', is_unique: 1 });
    expect(db().get('SELECT * FROM property_groups WHERE location_id = ? AND key = ?', dst, 'finanzen')).toBeTruthy();
    expect(db().all('SELECT name FROM association_labels WHERE location_id = ? ORDER BY name', dst).map((l) => l.name)).toEqual(['Entscheider', 'Rechnungsempfänger']);
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM object_records WHERE location_id = ?', dst)!.n).toBe(0);
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM companies WHERE location_id = ?', dst)!.n).toBe(0);
  });
});

describe('permissions, API keys and MCP', () => {
  it('limits members by area and read-only agency keys', async () => {
    const loc = t.api.location;
    await t.api.post('/api/users', { email: 'ma@example.com', password: 'geheim123', name: 'MA', role: 'member', locations: [loc], permissions: ['opportunities'] });
    const raw = async (path: string, init: RequestInit = {}) => {
      const login = await t.api.raw('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ma@example.com', password: 'geheim123' }) });
      const cookie = login.headers.get('set-cookie')!.split(';')[0];
      return t.api.raw(path, { ...init, headers: { cookie, 'x-pghl': '1', 'x-location-id': loc, 'content-type': 'application/json', ...(init.headers ?? {}) } });
    };
    expect((await raw('/api/companies')).status).toBe(403);
    expect((await raw('/api/objects/p_fahrzeuge/records')).status).toBe(403);
    expect((await raw('/api/associations?type=contact&id=x')).status).toBe(403);
    expect((await raw('/api/properties', { method: 'POST', body: JSON.stringify({ object: 'company', label: 'X' }) })).status).toBe(403);
    // Lookups stay readable (lists of types and labels).
    expect((await raw('/api/object-types')).status).toBe(200);
    expect((await raw('/api/properties')).status).toBe(200);

    const ro = (await t.api.post('/api/agency/api-keys', { name: 'lesen', scope: 'read' })).data.key;
    const h = { authorization: `Bearer ${ro}`, 'x-location-id': loc, 'content-type': 'application/json' };
    expect((await t.api.raw('/api/companies', { headers: h })).status).toBe(200);
    expect((await t.api.raw('/api/companies', { method: 'POST', headers: h, body: JSON.stringify({ name: 'Nope' }) })).status).toBe(403);
  });

  it('MCP tools list, upsert, search and associate', async () => {
    const key = (await t.api.post('/api/agency/api-keys', { name: 'mcp', scope: 'write' })).data.key;
    const loc = t.api.location;
    const call = async (name: string, args: any) => {
      const res = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      const j = await res.json();
      if (j.result.isError) throw new Error(j.result.content[0].text);
      return JSON.parse(j.result.content[0].text);
    };
    const co = await call('ghl_upsert_company', { location_id: loc, name: 'MCP AG', domain: 'mcp-ag.de', custom: { tier: 'A' } });
    expect(co).toMatchObject({ name: 'MCP AG', created: true });
    expect((await call('ghl_list_companies', { location_id: loc, query: 'mcp-ag' })).companies[0].id).toBe(co.id);
    const types = await call('ghl_list_object_types', { location_id: loc });
    expect(types.types[0].key).toBe('p_fahrzeuge');
    const rec = await call('ghl_upsert_record', { location_id: loc, object: 'p_fahrzeuge', properties: { name: 'MCP 1', marke: 'Tesla' } });
    expect(rec.created).toBe(true);
    const found = await call('ghl_search_records', { location_id: loc, object: 'p_fahrzeuge', filters: [{ field: 'marke', op: 'eq', value: 'tesla' }] });
    expect(found.records.map((r: any) => r.display)).toContain('MCP 1');
    const link = await call('ghl_associate', { location_id: loc, from_type: 'p_fahrzeuge', from_id: rec.id, to_type: 'company', to_id: co.id });
    expect(link.id).toBeTruthy();
    expect(await call('ghl_associate', { location_id: loc, from_type: 'p_fahrzeuge', from_id: rec.id, to_type: 'company', to_id: co.id, remove: true })).toMatchObject({ removed: true });
    await expect(call('ghl_upsert_record', { location_id: loc, object: 'p_fahrzeuge', properties: { name: 'MCP 2', marke: 'Trabant' } })).rejects.toThrow(/keine Option/);
  });

  it('mirrors companies, records and associations to Supabase', async () => {
    const tables = (await t.api.get('/api/agency/supabase')).data;
    expect(tables.tables).toEqual(expect.arrayContaining(['ghl_companies', 'ghl_object_records', 'ghl_associations']));
    expect(tables.sql).toContain('create table if not exists public.ghl_object_records');
    const sent: Record<string, any[]> = {};
    t.app.services.supabaseFetch = async (url: string, init: any) => {
      const table = url.split('/rest/v1/')[1].split('?')[0];
      if (init.method === 'POST') (sent[table] ??= []).push(...JSON.parse(init.body));
      return { status: 201, text: '' };
    };
    await t.api.patch('/api/agency/supabase', { url: 'https://abc.supabase.co', service_key: 'service-role-key', enabled: true });
    await t.api.post('/api/agency/supabase/sync', { full: true });
    expect(sent.ghl_companies.find((c) => c.domain === 'acme.de')).toMatchObject({ name: 'Acme Neu', custom: { tier: 'B' } });
    expect(sent.ghl_object_records.find((r) => r.display === 'MCP 1')).toMatchObject({ object_type: 'p_fahrzeuge', object_label: 'Fahrzeug', properties: { marke: 'Tesla' } });
    expect(sent.ghl_associations.some((a) => a.labels.includes('Entscheider'))).toBe(true);
    delete t.app.services.supabaseFetch;
  });
});

describe('imports and reports', () => {
  it('takes companies from imports idempotently by external id (HubSpot hook)', async () => {
    const S = t.app.services.companies;
    const loc = t.api.location;
    const input = { name: 'Hub GmbH', domain: 'hub-gmbh.de', website: 'https://hub-gmbh.de', phone: '040 112233', city: 'Hamburg', postal_code: '20095', country: 'DE', industry: 'Beratung', external_source: 'hubspot', external_id: 'c900' };
    const first = await S.upsert(loc, input);
    expect(first).toMatchObject({ created: true, company: { name: 'Hub GmbH', domain: 'hub-gmbh.de', external_source: 'hubspot', external_id: 'c900', source: 'HubSpot-Import' } });
    // Re-import with changed data: same company, updated fields, no duplicate.
    const again = await S.upsert(loc, { ...input, name: 'Hub GmbH & Co. KG', city: 'Bremen' });
    expect(again).toMatchObject({ id: first.id, created: false, company: { name: 'Hub GmbH & Co. KG', city: 'Bremen' } });
    // The importer's own id map wins (existing_id), even if the domain changed in HubSpot.
    const viaId = await S.upsert(loc, { ...input, domain: 'hub-neu.de', external_id: 'other', existing_id: first.id });
    expect(viaId.id).toBe(first.id);
    expect(db().get<{ n: number }>(`SELECT COUNT(*) AS n FROM companies WHERE location_id = ? AND name LIKE 'Hub GmbH%'`, loc)!.n).toBe(1);
    // A second HubSpot record with a known domain lands on the existing company (domain dedupe).
    const dup = await S.upsert(loc, { name: 'Hub (Duplikat)', domain: 'hub-neu.de', external_source: 'hubspot', external_id: 'c901' });
    expect(dup.id).toBe(first.id);
    const contact = (await t.api.post('/api/contacts', { first_name: 'Hubert', email: 'hubert@privat.example' })).data;
    await S.linkContact(loc, first.id, contact.id);
    await S.linkContact(loc, first.id, contact.id);
    const links = (await t.api.get(`/api/associations?type=contact&id=${contact.id}&to_type=company`)).data;
    expect(links.map((l: any) => [l.record_id, l.primary])).toEqual([[first.id, true]]);
    expect((await t.api.get(`/api/contacts/${contact.id}`)).data.company).toBe((await t.api.get(`/api/companies/${first.id}`)).data.name);
  });

  it('registers companies, custom objects and lead scores as report sources', async () => {
    const sources = t.app.services.reportSources as any[];
    const keys = sources.map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(['companies', 'lead_scores', 'records_p_fahrzeuge']));
    const car = sources.find((s) => s.key === 'records_p_fahrzeuge');
    expect(car.fields.map((f: any) => f.key)).toEqual(expect.arrayContaining(['p_marke', 'p_kilometer', 'p_preis', 'p_extras', 'p_elektro', 'owner']));
    // A new object type appears after the write that created it.
    await t.api.post('/api/object-types', { singular: 'Vertrag', plural: 'Verträge', properties: [{ label: 'Laufzeit', type: 'number' }] });
    expect((t.app.services.reportSources as any[]).some((s) => s.key === 'records_p_vertraege')).toBe(true);

    const run = (q: any) => t.api.post('/api/reports/run', { query: q }).then((r) => r.data);
    const byIndustry = await run({ source: 'companies', measures: ['count', 'sum:deals_value'], group_by: ['industry'], range: 'all' });
    expect(byIndustry.error, JSON.stringify(byIndustry)).toBeUndefined();
    const software = byIndustry.rows.find((r: any) => r.l[0] === 'Software');
    expect(software.v[0]).toBeGreaterThanOrEqual(1);
    const byBrand = await run({ source: 'records_p_fahrzeuge', measures: ['count', 'sum:p_kilometer'], group_by: ['p_marke'], range: 'all' });
    expect(byBrand.error, JSON.stringify(byBrand)).toBeUndefined();
    expect(byBrand.rows.map((r: any) => r.l[0])).toEqual(expect.arrayContaining(['VW', 'BMW']));
    const bySize = await run({ source: 'companies', group_by: ['size'], filters: [{ field: 'custom_tier', op: 'in', value: ['A', 'B'] }], range: 'all' });
    expect(bySize.error, JSON.stringify(bySize)).toBeUndefined();
  });
});
