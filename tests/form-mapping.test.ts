import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';

/** Form fields into company, deal and custom-object fields (modules/form-mapping.ts, docs/forms.md#field-mapping). */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let pipe: any;
let car: any;
const events: { type: string; data: any }[] = [];
const settle = () => t.app.events.flush();
const submit = (id: string, body: Record<string, unknown>) => t.api.post(`/api/public/forms/${id}/submit`, body);
const mk = async (name: string, fields: any[], settings: Record<string, any> = {}) => t.api.post('/api/forms', { name, fields, settings });
const db = () => t.app.db;
const contactByEmail = (email: string) => db().get('SELECT * FROM contacts WHERE location_id = ? AND email = ?', loc, email);
const links = (contactId: string, type: string) => (t.app.services.associations as any).ids(loc, { type: 'contact', id: contactId }, type) as string[];
const BASE = [
  { id: 'f1', type: 'text', label: 'Vorname', name: 'first_name', required: true },
  { id: 'f2', type: 'email', label: 'E-Mail', name: 'email', required: true },
];

beforeAll(async () => {
  process.env.PGHL_FORMS_PER_MINUTE = '10000';
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  for (const type of ['company.created', 'company.updated', 'opportunity.created', 'opportunity.updated', 'record.created', 'record.updated', 'form.submitted']) t.app.events.on(type, (e) => void events.push({ type, data: e.data }));
  pipe = (await t.api.post('/api/pipelines', { name: 'Vertrieb', stages: [{ name: 'Neu' }, { name: 'Qualifiziert' }] })).data;
  expect((await t.api.post('/api/properties', { object: 'company', label: 'Mitarbeiter Notiz', type: 'text' })).status).toBe(200);
  expect((await t.api.post('/api/properties', { object: 'opportunity', label: 'Budget Rahmen', type: 'select', options: ['klein', 'groß'] })).status).toBe(200);
  car = (await t.api.post('/api/object-types', { singular: 'Fahrzeug', plural: 'Fahrzeuge', primary_label: 'Kennzeichen', primary_unique: true })).data;
  expect((await t.api.post('/api/properties', { object: car.key, label: 'Kilometer', type: 'number' })).status).toBe(200);
}, 60_000);
afterAll(async () => {
  delete process.env.PGHL_FORMS_PER_MINUTE;
  await t.close();
});

describe('form mapping', () => {
  it('writes to a company: creates it, links it to the contact, fires company.created, fills only gaps later', async () => {
    const r = await mk('Firma', [...BASE, { id: 'c1', type: 'text', label: 'Firma', name: 'firma' }, { id: 'c2', type: 'text', label: 'Branche', name: 'branche' }, { id: 'c3', type: 'text', label: 'Notiz', name: 'notiz' }], {
      mapping: { fields: { c1: { target: 'company', key: 'name' }, c2: { target: 'company', key: 'industry' }, c3: { target: 'company', key: 'custom.mitarbeiter_notiz' } } },
    });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const form = r.data;
    expect(form.settings.mapping.fields.c1).toEqual({ target: 'company', key: 'name' });
    events.length = 0;
    const s = await submit(form.id, { first_name: 'Anna', email: 'anna@gmail.com', firma: 'Bäckerei Brandt', branche: 'Handwerk', notiz: '12 Leute' });
    expect(s.status, JSON.stringify(s.data)).toBe(200);
    await settle();
    const c = contactByEmail('anna@gmail.com');
    const companyIds = links(c.id, 'company');
    expect(companyIds).toHaveLength(1);
    const co = (t.app.services.companies as any).get(loc, companyIds[0]);
    expect(co).toMatchObject({ name: 'Bäckerei Brandt', industry: 'Handwerk', custom: { mitarbeiter_notiz: '12 Leute' } });
    expect(events.some((e) => e.type === 'company.created' && e.data.companyId === co.id)).toBe(true);
    const sub = db().get('SELECT meta FROM form_submissions WHERE id = ?', s.data.id);
    expect(JSON.parse(sub.meta).mapping.company_id).toBe(co.id);
    // second submission: the stored industry stays (no overwrite by an anonymous visitor), the same company is used
    await submit(form.id, { first_name: 'Anna', email: 'anna@gmail.com', firma: 'Bäckerei Brandt', branche: 'Gastro' });
    await settle();
    expect(links(c.id, 'company')).toEqual([co.id]);
    expect((t.app.services.companies as any).get(loc, co.id).industry).toBe('Handwerk');
    // with overwrite: it changes, company.updated fires
    await t.api.patch(`/api/forms/${form.id}`, { settings: { mapping: { ...form.settings.mapping, overwrite: true } } });
    events.length = 0;
    await submit(form.id, { first_name: 'Anna', email: 'anna@gmail.com', firma: 'Bäckerei Brandt', branche: 'Gastro' });
    await settle();
    expect((t.app.services.companies as any).get(loc, co.id).industry).toBe('Gastro');
    expect(events.some((e) => e.type === 'company.updated' && e.data.companyId === co.id)).toBe(true);
  });

  it('writes to a deal: a new deal in the chosen pipeline/stage with standard and custom fields', async () => {
    const stage = pipe.stages[1].id;
    const r = await mk('Anfrage', [...BASE, { id: 'd1', type: 'text', label: 'Budget', name: 'budget' }, { id: 'd2', type: 'radio', label: 'Rahmen', name: 'rahmen', options: ['klein', 'groß'] }, { id: 'd3', type: 'date', label: 'Start', name: 'start' }], {
      mapping: { fields: { d1: { target: 'opportunity', key: 'value' }, d2: { target: 'opportunity', key: 'custom.budget_rahmen' }, d3: { target: 'opportunity', key: 'expected_close_date' } }, deal: { mode: 'new', pipeline_id: pipe.id, stage_id: stage } },
      pipeline_id: pipe.id,
    });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    events.length = 0;
    const s = await submit(r.data.id, { first_name: 'Ben', email: 'ben@gmail.com', budget: '1.500', rahmen: 'groß', start: '2026-12-01' });
    expect(s.status, JSON.stringify(s.data)).toBe(200);
    await settle();
    const c = contactByEmail('ben@gmail.com');
    const opps = db().all('SELECT * FROM opportunities WHERE contact_id = ?', c.id);
    // the plain "create opportunity" setting does not add a second deal
    expect(opps).toHaveLength(1);
    expect(opps[0]).toMatchObject({ pipeline_id: pipe.id, stage_id: stage, value: 1500, expected_close_date: '2026-12-01', status: 'open' });
    const props = JSON.parse(db().get('SELECT props FROM record_props WHERE object_key = ? AND record_id = ?', 'opportunity', opps[0].id).props);
    expect(props.budget_rahmen).toBe('groß');
    expect(events.filter((e) => e.type === 'opportunity.created')).toHaveLength(1);
    // a value that is not a number is refused before anything is written
    const before = db().get('SELECT COUNT(*) AS n FROM form_submissions').n;
    const bad = await submit(r.data.id, { first_name: 'Ben', email: 'ben@gmail.com', budget: 'viel' });
    expect(bad.status).toBe(400);
    expect(db().get('SELECT COUNT(*) AS n FROM form_submissions').n).toBe(before);
  });

  it('updates the contact’s open deal in mode "open" (fills gaps, fires opportunity.updated)', async () => {
    const r = await mk('Nachfassen', [...BASE, { id: 'd1', type: 'number', label: 'Budget', name: 'budget' }, { id: 'd2', type: 'text', label: 'Quelle', name: 'quelle' }], {
      mapping: { fields: { d1: { target: 'opportunity', key: 'value' }, d2: { target: 'opportunity', key: 'source' } }, deal: { mode: 'open', pipeline_id: pipe.id } },
    });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.settings.mapping.deal).toEqual({ mode: 'open', pipeline_id: pipe.id, stage_id: pipe.stages[0].id });
    const c = (await t.api.post('/api/contacts', { first_name: 'Cleo', email: 'cleo@gmail.com' })).data;
    const opp = (await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: c.id, name: 'Cleo Deal' })).data;
    await settle();
    events.length = 0;
    await submit(r.data.id, { first_name: 'Cleo', email: 'cleo@gmail.com', budget: 900, quelle: 'Messe' });
    await settle();
    const opps = db().all('SELECT * FROM opportunities WHERE contact_id = ?', c.id);
    expect(opps).toHaveLength(1);
    expect(opps[0]).toMatchObject({ id: opp.id, value: 900, name: 'Cleo Deal' });
    expect(events.some((e) => e.type === 'opportunity.updated' && e.data.opportunity.id === opp.id)).toBe(true);
    // no open deal any more → a new one
    db().run("UPDATE opportunities SET status = 'won' WHERE id = ?", opp.id);
    await submit(r.data.id, { first_name: 'Cleo', email: 'cleo@gmail.com', budget: 50 });
    expect(db().all('SELECT * FROM opportunities WHERE contact_id = ?', c.id)).toHaveLength(2);
  });

  it('writes to a custom object: creates a record linked to the contact, the unique value updates it next time', async () => {
    const r = await mk('Fahrzeug', [...BASE, { id: 'o1', type: 'text', label: 'Kennzeichen', name: 'kz' }, { id: 'o2', type: 'number', label: 'km', name: 'km' }], {
      mapping: { fields: { o1: { target: 'object', object: car.key, key: 'name' }, o2: { target: 'object', object: car.key, key: 'kilometer' } }, overwrite: true },
    });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    events.length = 0;
    await submit(r.data.id, { first_name: 'Dora', email: 'dora@gmail.com', kz: 'B-HL 1', km: '12000' });
    await settle();
    const c = contactByEmail('dora@gmail.com');
    const ids = links(c.id, car.key);
    expect(ids).toHaveLength(1);
    const rec = db().get('SELECT * FROM object_records WHERE id = ?', ids[0]);
    expect(JSON.parse(rec.properties)).toMatchObject({ name: 'B-HL 1', kilometer: 12000 });
    expect(events.some((e) => e.type === 'record.created' && e.data.recordId === rec.id)).toBe(true);
    await submit(r.data.id, { first_name: 'Dora', email: 'dora@gmail.com', kz: 'B-HL 1', km: '15000' });
    await settle();
    expect(links(c.id, car.key)).toEqual([rec.id]);
    expect(JSON.parse(db().get('SELECT properties FROM object_records WHERE id = ?', rec.id).properties).kilometer).toBe(15000);
    expect(events.some((e) => e.type === 'record.updated' && e.data.recordId === rec.id)).toBe(true);
    // somebody else with the same plate does not take over or change Dora's car
    const s = await submit(r.data.id, { first_name: 'Eve', email: 'eve@gmail.com', kz: 'B-HL 1', km: '1' });
    expect(s.status).toBe(200);
    await settle();
    expect(JSON.parse(db().get('SELECT properties FROM object_records WHERE id = ?', rec.id).properties).kilometer).toBe(15000);
    expect(links(contactByEmail('eve@gmail.com').id, car.key)).toHaveLength(0);
    expect(JSON.parse(db().get('SELECT meta FROM form_submissions WHERE id = ?', s.data.id).meta).mapping.errors[0]).toMatch(/anderen Datensatz/);
  });

  it('refuses protected columns and unknown targets at save', async () => {
    const field = [...BASE, { id: 'x', type: 'text', label: 'X', name: 'x' }];
    for (const [target, key, msg] of [
      ['company', 'owner_id', /geschützt/],
      ['company', 'lifecycle_stage', /geschützt/],
      ['company', 'location_id', /geschützt/],
      ['opportunity', 'status', /geschützt/],
      ['opportunity', 'stage_id', /geschützt/],
      ['opportunity', 'assigned_to', /geschützt/],
      ['company', 'custom.gibtsnicht', /gibt es nicht/],
    ] as const) {
      const r = await mk('Böse', field, { mapping: { fields: { x: { target, key } }, deal: { pipeline_id: pipe.id } } });
      expect(r.status, `${target}.${key}`).toBe(400);
      expect(r.data.error, `${target}.${key}`).toMatch(msg);
    }
    expect((await mk('Böse', field, { mapping: { fields: { x: { target: 'object', object: 'p_gibtsnicht', key: 'name' } } } })).status).toBe(400);
    expect((await mk('Ohne Pipeline', field, { mapping: { fields: { x: { target: 'opportunity', key: 'name' } } } })).data.error).toMatch(/Pipeline/);
    // a user-type property cannot be filled by a visitor
    await t.api.post('/api/properties', { object: 'company', label: 'Betreuer', type: 'user' });
    expect((await mk('Böse', field, { mapping: { fields: { x: { target: 'company', key: 'custom.betreuer' } } } })).data.error).toMatch(/nicht setzen/);
    // a stored mapping edited behind the API's back: protected keys are still never written
    const ok = (await mk('Ok', field, { mapping: { fields: { x: { target: 'company', key: 'name' } } } })).data;
    const settings = { ...ok.settings, mapping: { fields: { x: { target: 'company', key: 'owner_id' } } } };
    db().run('UPDATE forms SET settings = ? WHERE id = ?', JSON.stringify(settings), ok.id);
    const s = await submit(ok.id, { first_name: 'Fred', email: 'fred@gmail.com', x: 'someone' });
    expect(s.status).toBe(200);
    expect(JSON.parse(db().get('SELECT meta FROM form_submissions WHERE id = ?', s.data.id).meta).mapping.errors[0]).toMatch(/geschützt/);
    // extra keys a visitor sends are ignored (only the form's fields count)
    const s2 = await submit(ok.id, { first_name: 'Gus', email: 'gus@gmail.com', x: 'Gus GmbH', owner_id: 'u1', status: 'won' });
    expect(s2.status).toBe(200);
  });

  it('refuses the protected owner column at save and skips it in older forms', async () => {
    const owner = db().get('SELECT id FROM users LIMIT 1').id;
    for (const name of ['assigned_to']) {
      for (const type of ['text', 'hidden']) {
        const r = await mk('Owner', [...BASE, { id: 'x', type, label: 'X', name, value: owner }]);
        expect(r.status, `${type} ${name}`).toBe(400);
        expect(r.data.error).toMatch(/geschützt/);
      }
    }
    // also when the fields are changed later
    const ok = (await mk('Ok', BASE)).data;
    expect((await t.api.patch(`/api/forms/${ok.id}`, { fields: [...BASE, { id: 'x', type: 'hidden', label: 'X', name: 'assigned_to' }] })).status).toBe(400);
    // a form stored before the rule (or copied in): the submission goes through, the owner stays untouched, meta says why; the source is allowed
    const fields = [...BASE, { id: 'x', type: 'hidden', label: 'Zuständig', name: 'assigned_to' }, { id: 'y', type: 'text', label: 'Quelle', name: 'source' }];
    db().run('UPDATE forms SET fields = ? WHERE id = ?', JSON.stringify(fields), ok.id);
    const s = await submit(ok.id, { first_name: 'Jana', email: 'jana@gmail.com', assigned_to: owner, source: 'Gefälscht' });
    expect(s.status, JSON.stringify(s.data)).toBe(200);
    const c = contactByEmail('jana@gmail.com');
    expect(c.assigned_to ?? null).toBeNull();
    expect(c.source).toBe('Gefälscht');
    const meta = JSON.parse(db().get('SELECT meta FROM form_submissions WHERE id = ?', s.data.id).meta);
    expect(meta.mapping.errors).toEqual([expect.stringMatching(/assigned_to.*geschützt/)]);
    // the allowed contact keys still work
    expect((await mk('Erlaubt', [...BASE, { id: 'z', type: 'text', label: 'Ort', name: 'city' }, { id: 'w', type: 'text', label: 'Land', name: 'country' }])).status).toBe(200);
  });

  it('keeps sub-accounts apart: pipelines and objects of another sub-account are refused, a copied mapping writes nothing there', async () => {
    const other = (await t.api.post('/api/locations', { name: 'Fremd GmbH' })).data.id;
    const mine = t.api.location;
    t.api.setLocation(other);
    const otherPipe = (await t.api.post('/api/pipelines', { name: 'Fremd', stages: [{ name: 'A' }] })).data;
    const field = [...BASE, { id: 'x', type: 'text', label: 'X', name: 'x' }];
    // the other sub-account cannot point at my object type or my pipeline
    expect((await mk('Fremd', field, { mapping: { fields: { x: { target: 'object', object: car.key, key: 'name' } } } })).status).toBe(400);
    expect((await mk('Fremd', field, { mapping: { fields: { x: { target: 'opportunity', key: 'name' } }, deal: { pipeline_id: pipe.id } } })).status).toBe(400);
    // a form whose stored mapping points at my pipeline (e.g. a copy): the deal is not created anywhere
    const f = (await mk('Kopie', field, { mapping: { fields: { x: { target: 'opportunity', key: 'name' } }, deal: { pipeline_id: otherPipe.id } } })).data;
    const settings = { ...f.settings, mapping: { ...f.settings.mapping, deal: { mode: 'new', pipeline_id: pipe.id, stage_id: pipe.stages[0].id } } };
    db().run('UPDATE forms SET settings = ? WHERE id = ?', JSON.stringify(settings), f.id);
    const before = db().get('SELECT COUNT(*) AS n FROM opportunities WHERE pipeline_id = ?', pipe.id).n;
    const s = await submit(f.id, { first_name: 'Hans', email: 'hans@gmail.com', x: 'Deal' });
    expect(s.status).toBe(200);
    expect(db().get('SELECT COUNT(*) AS n FROM opportunities WHERE pipeline_id = ?', pipe.id).n).toBe(before);
    // the other sub-account cannot read my form's mapping
    t.api.setLocation(mine);
    const myForm = (await mk('Meins', field, { mapping: { fields: { x: { target: 'company', key: 'name' } } } })).data;
    t.api.setLocation(other);
    expect((await t.api.get(`/api/forms/${myForm.id}/mapping`)).status).toBe(404);
    t.api.setLocation(mine);
  });

  it('leaves existing forms unchanged and drops entries of removed fields', async () => {
    const plain = (await t.api.post('/api/forms', { name: 'Kontakt', settings: { pipeline_id: pipe.id } })).data;
    expect(plain.settings.mapping).toBeUndefined();
    const s = await submit(plain.id, { first_name: 'Ida', email: 'ida@gmail.com', consent: 'on' });
    expect(s.status, JSON.stringify(s.data)).toBe(200);
    await settle();
    const c = contactByEmail('ida@gmail.com');
    expect(db().all('SELECT * FROM opportunities WHERE contact_id = ?', c.id)).toHaveLength(1);
    expect(JSON.parse(db().get('SELECT meta FROM form_submissions WHERE id = ?', s.data.id).meta).mapping).toBeUndefined();
    // a field with a mapping removed: the mapping entry goes with it
    const f = (await mk('Weg', [...BASE, { id: 'x', type: 'text', label: 'X', name: 'x' }], { mapping: { fields: { x: { target: 'company', key: 'name' } } } })).data;
    const p = await t.api.patch(`/api/forms/${f.id}`, { fields: BASE });
    expect(p.status).toBe(200);
    expect(p.data.settings.mapping).toBeUndefined();
    // mapping: null removes it
    const g = (await mk('Weg2', [...BASE, { id: 'x', type: 'text', label: 'X', name: 'x' }], { mapping: { fields: { x: { target: 'company', key: 'name' } } } })).data;
    expect((await t.api.patch(`/api/forms/${g.id}`, { settings: { mapping: null } })).data.settings.mapping).toBeUndefined();
  });

  it('shows the mapping and the targets read-only (route and agent tool)', async () => {
    const f = (await mk('Lesen', [...BASE, { id: 'x', type: 'text', label: 'Firmenname', name: 'x' }], { mapping: { fields: { x: { target: 'company', key: 'name' } } } })).data;
    const r = (await t.api.get(`/api/forms/${f.id}/mapping`)).data;
    expect(r.fields).toEqual([expect.objectContaining({ field_id: 'x', field: 'Firmenname', target: 'company', key: 'name', label: 'Firma: Name' })]);
    expect(r.targets.company.map((x: any) => x.key)).toEqual(expect.arrayContaining(['name', 'domain', 'custom.mitarbeiter_notiz']));
    expect(r.targets.company.map((x: any) => x.key)).not.toContain('owner_id');
    expect(r.targets.company.map((x: any) => x.key)).not.toContain('custom.betreuer');
    expect(r.targets.opportunity.map((x: any) => x.key)).not.toContain('status');
    expect(r.targets.objects.find((o: any) => o.key === car.key)?.properties.map((p: any) => p.key)).toEqual(expect.arrayContaining(['name', 'kilometer']));
    expect(r.targets.pipelines.find((p: any) => p.id === pipe.id)?.stages).toHaveLength(2);
    const tool = (t.app.services.mcpTools as any[]).find((x) => x.name === 'ghl_form_mapping');
    expect(tool.annotations.readOnlyHint).toBe(true);
    const out = await tool.run({ api: async (m: string, path: string) => (await t.api.get(path)).data, agency: false }, { form_id: f.id });
    expect(out.fields[0].label).toBe('Firma: Name');
    const list = (t.app.services.mcpTools as any[]).find((x) => x.name === 'ghl_list_forms');
    const forms = await list.run({ api: async (m: string, path: string) => (await t.api.get(path)).data, agency: false }, {});
    expect(forms.find((x: any) => x.id === f.id).mapping).toEqual({ company: 1 });
  });
});
