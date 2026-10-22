import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answerText, flatFields, typeformBase, typeformField, typeformForm, typeformResponse } from '../server/services/umzug-typeform.js';
import { FakeTypeform, TYPEFORM_TOKEN } from './umzug3-fakes.js';
import { umzugHarness, type Harness } from './umzug2-harness.js';

let h: Harness;
const fake = new FakeTypeform();
let imported: any;
const creds = { token: TYPEFORM_TOKEN };
const form = (name: string) => h.one('SELECT * FROM forms WHERE location_id = ? AND name = ?', name);
const subs = (formId: string) => h.q('SELECT * FROM form_submissions WHERE location_id = ? AND form_id = ? ORDER BY created_at', formId).map((s: any) => ({ ...s, data: JSON.parse(s.data), meta: JSON.parse(s.meta) }));

beforeAll(async () => {
  h = await umzugHarness();
  h.t.app.services.umzugFetch = fake.fetch;
  await h.fresh('Typeform');
});
afterAll(() => h.t.close());

describe('Typeform: pure parts', () => {
  it('chooses the data center', () => {
    expect(typeformBase('')).toBe('https://api.typeform.com');
    expect(typeformBase('EU')).toBe('https://api.eu.typeform.com');
    expect(() => typeformBase('evil.example.com')).toThrow(/Rechenzentrum/);
  });
  it('maps question types', () => {
    const f = (type: string, extra: any = {}) => typeformField({ id: 'x', type, title: 'T', ...extra });
    expect(f('short_text', { validations: { required: true } })).toEqual({ label: 'T', type: 'text', required: true });
    expect(f('yes_no')).toMatchObject({ type: 'radio', options: ['Ja', 'Nein'] });
    expect(f('legal')).toMatchObject({ type: 'checkbox' });
    expect(f('multiple_choice', { properties: { choices: [{ label: 'A' }], allow_multiple_selection: true } })).toMatchObject({ type: 'checkbox', options: ['A'] });
    expect(f('nps')).toMatchObject({ type: 'number' });
    expect(f('statement')).toBeUndefined();
    expect(f('file_upload')?.label).toContain('Datei-Upload bei Typeform');
    expect(f('short_text', { title: 'Hallo {{field:abc}} *du*' })?.label).toBe('Hallo … du');
  });
  it('opens groups', () => {
    expect(flatFields(fake.forms[0].fields).map((x) => x.id)).toContain('q14');
    expect(flatFields(fake.forms[0].fields).map((x) => x.id)).not.toContain('g1');
  });
  it('builds a form record with a note about what was left out', () => {
    const f = typeformForm(fake.forms[0]);
    expect(f.ext).toBe('f:F1');
    expect(f.fields).toHaveLength(13);
    expect(f.note).toContain('Logik');
    expect(f.note).toContain('1 Blöcke');
  });
  it('reads answers as text', () => {
    expect(answerText({ type: 'choices', choices: { labels: ['A', 'B'], other: 'C' } })).toEqual(['A', 'B', 'C']);
    expect(answerText({ type: 'boolean', boolean: false })).toBe('Nein');
    expect(answerText({ type: 'date', date: '2024-04-02T00:00:00Z' })).toBe('2024-04-02');
    expect(answerText({ type: 'number', number: 0 })).toBe('0');
  });
  it('turns a response into an answer sheet and a contact', () => {
    const x = typeformResponse(fake.responses.F1[0], fake.forms[0], true);
    expect(x.submission).toMatchObject({ ext: 'r:t1', form: 'f:F1', contact: 'e:anna@example.com', at: '2024-03-01T10:00:00.000Z' });
    expect(x.submission.answers['Wie heißt du?']).toBe('Anna Alt');
    expect(x.submission.answers['Hallo …, was möchtest du wissen?']).toBe('Preise?');
    expect(x.submission.answers.Interessen).toEqual(['CRM', 'E-Mail']);
    expect(x.contact).toMatchObject({ ext: 'e:anna@example.com', values: { email: 'Anna@Example.com', first_name: 'Anna', last_name: 'Alt', phone: '+49 30 1234567' } });
    expect(x.contact?.proof).toMatchObject([{ basis: 'none' }]);
    expect(typeformResponse(fake.responses.F1[3], fake.forms[0], true).contact).toBeUndefined();
  });
});

describe('Typeform: connect and preview', () => {
  it('refuses a wrong token and a bad data center; connects without returning the token', async () => {
    expect((await h.t.api.put('/api/umzug/connections/typeform', { token: 'falsch' })).status).toBe(400);
    expect((await h.t.api.put('/api/umzug/connections/typeform', { ...creds, data_center: 'evil' })).status).toBe(400);
    const r = await h.t.api.put('/api/umzug/connections/typeform', creds);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ account: 'tf-tfu1', label: 'Muster GmbH' });
    expect(JSON.stringify(r.data)).not.toContain(TYPEFORM_TOKEN);
  });
  it('counts forms and responses; offers the contact fields for the mapping', async () => {
    const r = await h.t.api.post('/api/umzug/preview', { source: 'typeform', parts: ['forms', 'submissions', 'contacts'] });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.counts.find((c: any) => c.key === 'forms').total).toBe(2);
    expect(r.data.counts.find((c: any) => c.key === 'responses').total).toBe(6);
    expect(r.data.fields.map((f: any) => f.ref)).toEqual(['email', 'first_name', 'last_name', 'phone']);
    expect(r.data.mapping).toMatchObject({ email: 'email', first_name: 'first_name', phone: 'phone' });
  });
  it('routes the EU data center to its own host', async () => {
    fake.host = 'api.eu.typeform.com';
    const r = await h.t.api.put('/api/umzug/connections/typeform', { ...creds, data_center: 'eu' });
    fake.host = 'api.typeform.com';
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.label).toContain('(EU)');
    expect((await h.t.api.put('/api/umzug/connections/typeform', creds)).status).toBe(200);
  });
});

describe('Typeform: import', () => {
  it('answers need their form: without it they are skipped with a note', async () => {
    const job = await h.run({ source: 'typeform', parts: ['submissions'] });
    expect(job.status, job.error).toBe('done');
    expect(h.lines(job).submissions.skipped).toBe(6);
    expect(job.warnings.join(' ')).toContain('Teil „Formulare“ mitnehmen');
    expect(h.count('form_submissions')).toBe(0);
    await h.undo(job.id);
  });

  it('a dry run writes nothing', async () => {
    const job = await h.run({ source: 'typeform', parts: ['forms', 'submissions', 'contacts'] }, 'dry-run');
    expect(job.status, job.error).toBe('done');
    expect(h.count('forms')).toBe(0);
    expect(h.lines(job).submissions.created).toBe(6);
  });

  it('imports forms and links answers to contacts that exist already (nobody is created without the contacts part)', async () => {
    h.t.app.services.contacts?.upsert?.(h.loc(), { email: 'anna@example.com', first_name: 'Anna' });
    if (!h.email('anna@example.com')) h.t.app.db.insert('contacts', { id: 'c-anna', location_id: h.loc(), first_name: 'Anna', last_name: '', email: 'anna@example.com', phone: '', tags: '[]', custom: '{}', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    imported = await h.run({ source: 'typeform', parts: ['forms', 'submissions'] });
    expect(imported.status, imported.error).toBe('done');
    const f = form('Kontaktformular (aus Typeform, bitte prüfen)')!;
    expect(f).toBeTruthy();
    const fields = JSON.parse(f.fields);
    expect(fields.map((x: any) => x.type)).toEqual(['text', 'email', 'phone', 'textarea', 'radio', 'checkbox', 'radio', 'checkbox', 'select', 'number', 'date', 'text', 'text', 'consent']);
    expect(fields[0]).toMatchObject({ label: 'Wie heißt du?', required: true });
    expect(fields[5].options).toEqual(['CRM', 'E-Mail']);
    const list = subs(f.id);
    expect(list).toHaveLength(5);
    expect(list[0].created_at).toBe('2024-03-01T10:00:00.000Z');
    expect(list[0].data).toMatchObject({ 'Wie heißt du?': 'Anna Alt', Interessen: ['CRM', 'E-Mail'], 'Rückruf gewünscht?': 'Ja', 'Wie zufrieden?': '4', Wunschtermin: '2024-04-02' });
    expect(list[0].data.Anhang).toContain('Datei bei Typeform');
    expect(list[1].data.Interessen).toEqual(['CRM', 'Sonstiges']);
    expect(list[1].data['Rückruf gewünscht?']).toBe('Nein');
    expect(list[4].data['Verstecktes Feld: utm_source']).toBe('newsletter');
    expect(list[4].data['Verstecktes Feld: leer']).toBeUndefined();
    expect(list[0].meta).toMatchObject({ referer: 'https://muster.example.com/kontakt', import: 'Typeform' });
    // Anna exists: both of her answers are hers; Ben and Cleo are not contacts (the part is off)
    const anna = h.email('anna@example.com');
    expect(list[0].contact_id).toBe(anna.id);
    expect(list[2].contact_id).toBe(anna.id);
    expect(list[1].contact_id).toBeNull();
    expect(h.email('ben@example.com')).toBeUndefined();
    expect(form('Umfrage (aus Typeform, bitte prüfen)')).toBeTruthy();
    expect(h.lines(imported).submissions.created).toBe(6);
    expect(h.count('form_submissions')).toBe(6);
    expect(h.count('consent_events')).toBe(0);
  });

  it('with the contacts part the senders become contacts without advertising consent, once each', async () => {
    const job = await h.run({ source: 'typeform', parts: ['forms', 'submissions', 'contacts'] });
    expect(job.status, job.error).toBe('done');
    expect(h.email('ben@example.com')).toMatchObject({ first_name: 'Ben', last_name: 'Bau' });
    expect(h.email('cleo@example.com')).toBeTruthy();
    expect(h.ledger('cleo@example.com')).toMatchObject([{ action: 'declined', channel: 'email', source_label: 'Umzug aus Typeform' }]);
    expect(h.ledger('cleo@example.com')[0].note).toContain('Kontaktformular');
    const l = h.lines(job);
    expect(l.contacts).toMatchObject({ created: 2, updated: 1 });
    expect(l.submissions).toMatchObject({ created: 0, updated: 6 });
    const f = form('Kontaktformular (aus Typeform, bitte prüfen)')!;
    expect(subs(f.id).filter((s: any) => s.contact_id).length).toBe(4);
    expect(h.count('form_submissions')).toBe(6);
  });

  it('a second run creates nothing twice', async () => {
    const again = await h.run({ source: 'typeform', parts: ['forms', 'submissions', 'contacts'] });
    const l = h.lines(again);
    expect(l.forms).toMatchObject({ created: 0, updated: 2 });
    expect(l.submissions).toMatchObject({ created: 0, updated: 6 });
    expect(l.contacts.created).toBe(0);
    expect(h.count('form_submissions')).toBe(6);
  });

  it('never wrote the token anywhere', () => {
    expect(JSON.stringify(h.t.app.db.all('SELECT log, warnings, progress, result FROM umzug_jobs'))).not.toContain(TYPEFORM_TOKEN);
  });
});

describe('Typeform: undo', () => {
  it('removes answers, forms and the contacts it created', async () => {
    const job = await h.undo(imported.id);
    expect(job.undo.deleted).toMatchObject({ submissions: 6, form: 2 });
    expect(h.count('form_submissions')).toBe(0);
    expect(h.count('forms')).toBe(0);
    // the contacts came with the next job: they stay until that one is undone
    expect(h.email('ben@example.com')).toBeTruthy();
  });
});
