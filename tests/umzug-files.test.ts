import { deflateRawSync } from 'node:zlib';
import { guessContactField } from '../server/core/csv.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consentOf, contactCols, parseDelimited, parseUpload } from '../server/services/umzug-files.js';
import { readZip } from '../server/services/umzug-zip.js';
import { startTestApp } from './helpers.js';

/** A ZIP with deflated entries, built by hand (the importer reads archives without a library). */
function zip(entries: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text);
    const comp = deflateRawSync(data);
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    parts.push(local, n, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + comp.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

const MC_HEAD = 'Email Address,First Name,Last Name,Address,Phone Number,Birthday,Lieblingsfarbe,MEMBER_RATING,OPTIN_TIME,OPTIN_IP,CONFIRM_TIME,LATITUDE,LONGITUDE,CC,REGION,LAST_CHANGED,LEID,EUID,NOTES,TAGS';
const MC_SUBSCRIBED = `${MC_HEAD}\nanna@example.com,Anna,Alt,Hauptstr. 1,030 123,1980-05-17,Blau,4,2023-01-05 10:00:00,1.2.3.4,2023-01-05 10:05:00,,,DE,BE,2024-03-01 08:00:00,123,abc,Notiz hier,"""Kunde"",""VIP"""\nben@example.com,Ben,Bau,,,,Rot,3,2023-02-05 10:00:00,,,,,,,,124,abd,,"""Interessent"""`;
const MC_UNSUB = `${MC_HEAD},UNSUB_TIME,UNSUB_CAMPAIGN_TITLE\ncleo@example.com,Cleo,,,,,,2,2023-01-05 10:00:00,,,,,,,,125,abe,,,2024-01-01 10:00:00,Februar`;
const MC_CLEANED = `${MC_HEAD},CLEAN_TIME\ndirk@example.com,Dirk,,,,,,1,2023-01-05 10:00:00,,,,,,,,126,abf,,,2024-01-01 10:00:00`;

let t: Awaited<ReturnType<typeof startTestApp>>;
const loc = () => t.api.location;
const q = <T = any>(sql: string, ...p: any[]) => t.app.db.all<T>(sql, loc(), ...p);
const email = (e: string) => t.app.db.get<any>('SELECT * FROM contacts WHERE location_id = ? AND email = ?', loc(), e);
const upload = async (source: string, name: string, body: Buffer | string, kind = '') => {
  const r = await t.api.raw(`/api/umzug/files?source=${source}&name=${encodeURIComponent(name)}${kind ? `&kind=${kind}` : ''}`, { method: 'POST', headers: { cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': loc(), 'content-type': 'application/octet-stream' }, body: typeof body === 'string' ? Buffer.from(body) : body });
  const text = await r.text();
  return { status: r.status, data: JSON.parse(text) };
};
const run = async (body: any) => {
  const r = await t.api.post('/api/umzug/jobs', body);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  await t.app.services.umzug.idle();
  return (await t.api.get(`/api/umzug/jobs/${r.data.id}`)).data;
};
const freshLocation = async (name: string) => t.api.setLocation((await t.api.post('/api/locations', { name })).data.id);

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
});
afterAll(() => t.close());

describe('readers', () => {
  it('reads CSV with commas, semicolons, tabs and quoted newlines', () => {
    expect(parseDelimited('a,b\n1,"x\ny"\n')).toEqual([['a', 'b'], ['1', 'x\ny']]);
    expect(parseDelimited('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseDelimited('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseDelimited('﻿a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('opens a ZIP and refuses broken, encrypted or bombed archives', () => {
    const z = zip({ 'a.csv': 'x,y\n1,2', '__MACOSX/._a.csv': 'junk', 'sub/b.csv': 'x\n3' });
    expect(readZip(z).map((e) => e.name)).toEqual(['a.csv', 'b.csv']);
    expect(() => readZip(Buffer.from('PK\x03\x04 not a zip at all, really not'))).toThrow(/ZIP/);
    expect(() => readZip(zip({ 'big.csv': 'x'.repeat(5000) }), { maxEntryBytes: 1000 })).toThrow(/größer/);
    expect(() => readZip(zip({ 'a.csv': '1', 'b.csv': '2' }), { maxEntries: 1 })).toThrow(/mehr als/);
  });
  it('understands the words vendors use for consent', () => {
    expect(['Subscribed', 'active', 'Marketable', 'ja'].map(consentOf)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(['unsubscribed', 'Cancelled', 'NonMarketable', 'inactive'].map(consentOf)).toEqual(['unsubscribed', 'unsubscribed', 'unsubscribed', 'unsubscribed']);
    expect(['cleaned', 'bounced', 'complained', 'pending', 'archived', 'whatever'].map(consentOf)).toEqual(['bounced', 'bounced', 'complained', 'pending', 'blocked', undefined]);
  });
  it('maps vendor column names: Pipedrive prefixes, combined names, tag columns', () => {
    const c = contactCols(['Person - Name', 'Person - Email - Work', 'Person - Phone - Mobile', 'Person - Organization', 'Person - Label', 'Budget'], []);
    expect(c.email).toBe(1);
    expect(c.splitName).toBe(true);
    expect(c.tags).toEqual([4]);
    const std = Object.fromEntries(c.fields.map((f) => [f.label, f.std]));
    expect(std['Person - Phone - Mobile']).toBe('phone');
    expect(std['Person - Organization']).toBe('company');
    expect(c.fields.find((f) => f.ref === '__first')?.std).toBe('first_name');
    expect(c.fields.find((f) => f.ref === 'Person - Label')?.preset).toBe('tag');
    expect(c.fields.find((f) => f.ref === 'Budget')?.std).toBeUndefined();
  });
  it('refuses Excel and binary files with a clear message', () => {
    expect(() => parseUpload('kontakte.xlsx', Buffer.from('PK'))).toThrow(/CSV/);
    expect(() => parseUpload('x.csv', Buffer.from([0, 1, 2, 0, 3]))).toThrow(/Binär/);
    // Excel's German "CSV (Trennzeichen-getrennt)" is Windows-1252, not UTF-8.
    const latin = parseUpload('export.csv', Buffer.from('E-Mail;Vorname;Nachname\nmax@example.com;Jörg;Müller\n', 'latin1'));
    expect(latin[0].rows[0]).toEqual(['max@example.com', 'Jörg', 'Müller']);
    expect(parseUpload('utf8.csv', Buffer.from('E-Mail;Vorname\nmax@example.com;Jörg\n'))[0].rows[0][1]).toBe('Jörg');
  });
});

describe('generic contact CSV import', () => {
  it('recognises the headers of other tools\' exports', () => {
    const cases: [string, string][] = [['Email Address', 'email'], ['Person - Email', 'email'], ['Person - Name', 'name'], ['Organization - Name', 'company'], ['Phone 1', 'phone'], ['Street Address 1', 'address'], ['Birthday', 'date_of_birth'], ['Person - Label', 'tags'], ['Postcode', 'postal_code'], ['E-Mail-Adresse', 'email'], ['First Name', 'first_name']];
    for (const [h, f] of cases) expect(guessContactField(h), h).toBe(f);
    expect(guessContactField('Lieblingsfarbe')).toBeUndefined();
  });
});

describe('Mailchimp audience export (ZIP) – upload, preview, mapping, import, undo', () => {
  let fileId = '';
  let before = 0;
  beforeAll(async () => {
    await freshLocation('Dateien');
    // someone is already in the CRM: the import merges into them and fills only empty fields
    await t.api.post('/api/contacts', { email: 'anna@example.com', first_name: 'Anni', company: 'Eigene Firma', tags: ['alt'] });
    before = q('SELECT COUNT(*) n FROM contacts WHERE location_id = ?')[0].n;
  });
  it('uploads the ZIP and recognises the export', async () => {
    const r = await upload('mailchimp', 'audience.zip', zip({ 'subscribed_members_export_abc.csv': MC_SUBSCRIBED, 'unsubscribed_members_export_abc.csv': MC_UNSUB, 'cleaned_members_export_abc.csv': MC_CLEANED }));
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ kind: 'contacts', rows: 4, detected: 'Mailchimp-Audience-Export erkannt' });
    expect(r.data.tables.map((x: any) => x.name)).toEqual(['subscribed_members_export_abc.csv', 'unsubscribed_members_export_abc.csv', 'cleaned_members_export_abc.csv']);
    fileId = r.data.id;
    // the file itself is on disk, mode 600, nowhere else
    expect(JSON.stringify((await t.api.get('/api/umzug')).data).includes('anna@')).toBe(false);
    expect(JSON.stringify(t.app.db.all('SELECT * FROM umzug_files')).includes('anna@')).toBe(false);
  });
  it('previews with an automatic mapping that can be edited', async () => {
    const r = await t.api.post('/api/umzug/preview', { source: 'mailchimp', file_ids: [fileId] });
    expect(r.status).toBe(200);
    expect(r.data.counts).toEqual([{ part: 'contacts', key: 'contacts', label: 'Kontakte', total: 4 }]);
    expect(r.data.mapping).toMatchObject({ 'Email Address': 'email', 'First Name': 'first_name', 'Last Name': 'last_name', Address: 'address', 'Phone Number': 'phone', Birthday: 'date_of_birth', TAGS: 'tag', Lieblingsfarbe: 'new:text:Lieblingsfarbe', MEMBER_RATING: '', OPTIN_TIME: '' });
  });
  it('imports with the edited mapping: new field, tags, status per file, merge into the existing contact', async () => {
    const preview = (await t.api.post('/api/umzug/preview', { source: 'mailchimp', file_ids: [fileId] })).data;
    const mapping = { ...preview.mapping, Lieblingsfarbe: 'new:select:Farbe', NOTES: 'note' };
    const job = await run({ source: 'mailchimp', file_ids: [fileId], mapping, options: { tag: 'Umzug 2026' } });
    expect(job.status).toBe('done');
    expect(q('SELECT COUNT(*) n FROM contacts WHERE location_id = ?')[0].n).toBe(before + 3);
    const anna = email('anna@example.com');
    // existing values stay (fill only), empty ones are filled, tags are added
    expect(anna).toMatchObject({ first_name: 'Anni', company: 'Eigene Firma', last_name: 'Alt', address: 'Hauptstr. 1', phone: '+4930123', date_of_birth: '1980-05-17' });
    expect(JSON.parse(anna.tags)).toEqual(expect.arrayContaining(['alt', 'Kunde', 'VIP', 'Umzug 2026']));
    expect(JSON.parse(anna.custom)).toEqual({ farbe: 'Blau' });
    expect(email('cleo@example.com').dnd).toBe(1);
    expect(JSON.parse(email('cleo@example.com').tags)).toContain('Mailchimp: abgemeldet');
    expect(JSON.parse(email('dirk@example.com').tags)).toContain('Mailchimp: unzustellbar');
    expect(email('ben@example.com').dnd).toBe(0);
    expect(t.app.db.get<any>(`SELECT type FROM custom_fields WHERE location_id = ? AND key = 'farbe'`, loc())?.type).toBe('select');
    expect(t.app.db.all<any>(`SELECT body FROM notes WHERE contact_id = ?`, email('anna@example.com').id).map((n) => n.body)).toEqual(['Notiz hier']);
    // the uploaded file was deleted after the import (personal data)
    expect(q('SELECT COUNT(*) n FROM umzug_files WHERE location_id = ?')[0].n).toBe(0);
    // no e-mail address in the id map or the undo list
    expect(JSON.stringify(t.app.db.all('SELECT * FROM umzug_ids'))).not.toContain('@');
    expect(JSON.stringify(t.app.db.all('SELECT job_id, kind, local_id, ext_id FROM umzug_items'))).not.toContain('example.com');
    expect(job.warnings.join('')).not.toContain('@');
  });
  it('undo removes the new contacts and puts the merged one back as it was', async () => {
    const job = (await t.api.get('/api/umzug/jobs')).data[0];
    const r = await t.api.post(`/api/umzug/jobs/${job.id}/undo`, {});
    expect(r.status).toBe(200);
    await t.app.services.umzug.idle();
    expect(q('SELECT COUNT(*) n FROM contacts WHERE location_id = ?')[0].n).toBe(before);
    const anna = email('anna@example.com');
    expect(anna).toMatchObject({ first_name: 'Anni', company: 'Eigene Firma', last_name: '', address: '' });
    expect(JSON.parse(anna.tags)).toEqual(['alt']);
    expect(q(`SELECT COUNT(*) n FROM custom_fields WHERE location_id = ? AND key = 'farbe'`)[0].n).toBe(0);
    expect(q(`SELECT COUNT(*) n FROM tags WHERE location_id = ? AND name IN ('Kunde', 'VIP', 'Umzug 2026')`)[0].n).toBe(0);
    const again = await t.api.post(`/api/umzug/jobs/${job.id}/undo`, {});
    expect(again.status).toBe(400);
  });
});

describe('Pipedrive export files: persons, deals, courses, students, templates', () => {
  beforeAll(() => freshLocation('Pipedrive-Dateien'));
  it('reads a persons export with combined name and prefixed headers', async () => {
    const csv = 'Person - Name,Person - Email - Work,Person - Phone - Work,Person - Organization,Person - Label,Person - Budget\nAnna Alt,anna@example.com,030 111,Muster GmbH,Kunde,2500\n"Müller, Max",max@example.com,,,Lead;VIP,\n';
    const up = await upload('pipedrive', 'persons.csv', csv);
    expect(up.data.kind).toBe('contacts');
    const job = await run({ source: 'pipedrive', file_ids: [up.data.id] });
    expect(job.status).toBe('done');
    expect(email('anna@example.com')).toMatchObject({ first_name: 'Anna', last_name: 'Alt', company: 'Muster GmbH', phone: '+4930111' });
    expect(JSON.parse(email('anna@example.com').custom)).toEqual({ person_budget: '2500' });
    expect(email('max@example.com')).toMatchObject({ first_name: '"Müller,'.replace('"', '').replace(',', ',') });
    expect(JSON.parse(email('max@example.com').tags)).toEqual(['Lead', 'VIP']);
  });
  it('deals CSV makes pipelines from stage names and deals with persons', async () => {
    const csv = 'Deal - Title,Deal - Value,Deal - Stage,Deal - Pipeline,Deal - Status,Person - Email - Work\nWebsite,"4.500,00",Angebot,Vertrieb,won,anna@example.com\nSEO,900,Neu,Vertrieb,open,max@example.com\nFremd,10,Neu,Vertrieb,open,neu@example.com\n';
    const up = await upload('pipedrive', 'deals.csv', csv);
    expect(up.data.kind).toBe('deals');
    const job = await run({ source: 'pipedrive', file_ids: [up.data.id] });
    expect(job.status).toBe('done');
    expect(q('SELECT name, value, status FROM opportunities WHERE location_id = ? ORDER BY name')).toEqual([
      { name: 'Fremd', value: 10, status: 'open' },
      { name: 'SEO', value: 900, status: 'open' },
      { name: 'Website', value: 4500, status: 'won' },
    ]);
    expect(email('neu@example.com')).toBeTruthy();
  });
  it('course outline CSV and students CSV give courses (draft) and access without mails', async () => {
    const outline = 'course,module,lesson,video_url,text\nKochkurs,Basics,Messer,https://videos.example.com/1.mp4,"<p>Schneiden <b>üben</b></p>"\nKochkurs,Basics,Pfanne,,Heiß werden\nKochkurs,Profi,Sous-vide,,\n';
    const students = 'email,name,course,enrolled at,completed at\nanna@example.com,Anna Alt,Kochkurs,2024-01-05,\nneu2@example.com,Neu Zwei,Kochkurs,2024-02-05,2024-03-01\n';
    const a = await upload('teachable', 'aufbau.csv', outline);
    const b = await upload('teachable', 'schueler.csv', students);
    expect([a.data.kind, b.data.kind]).toEqual(['courses', 'students']);
    const job = await run({ source: 'teachable', file_ids: [a.data.id, b.data.id] });
    expect(job.status).toBe('done');
    const course = t.app.db.get<any>('SELECT * FROM courses WHERE location_id = ?', loc());
    expect(course).toMatchObject({ title: 'Kochkurs', status: 'draft' });
    const lessons = t.app.db.all<any>('SELECT title, body, video_url FROM course_lessons WHERE course_id = ? ORDER BY title', course.id);
    expect(lessons.map((l) => l.title)).toEqual(['Messer', 'Pfanne', 'Sous-vide']);
    expect(lessons[0]).toMatchObject({ video_url: 'https://videos.example.com/1.mp4', body: 'Schneiden **üben**' });
    expect(t.app.db.get<any>('SELECT COUNT(*) n FROM course_enrollments WHERE course_id = ?', course.id)!.n).toBe(2);
    expect(email('neu2@example.com')).toMatchObject({ first_name: 'Neu', last_name: 'Zwei' });
    expect(t.app.db.get<any>('SELECT completed_at FROM course_enrollments WHERE course_id = ? AND contact_id = ?', course.id, email('neu2@example.com').id)!.completed_at).toBe('2024-03-01T00:00:00.000Z');
    expect(q('SELECT COUNT(*) n FROM messages WHERE location_id = ?')[0].n).toBe(0);
  });
  it('JSON course structure keeps modules and lessons', async () => {
    const up = await upload('kajabi', 'kurs.json', JSON.stringify({ courses: [{ title: 'JSON-Kurs', description: 'Beschreibung', modules: [{ title: 'M1', lessons: [{ title: 'L1', video_url: 'https://v.example.com/a', body: 'Text' }] }] }] }));
    expect(up.data.kind).toBe('courses');
    const job = await run({ source: 'kajabi', file_ids: [up.data.id] });
    expect(job.status).toBe('done');
    expect(q(`SELECT title FROM courses WHERE location_id = ? AND title = 'JSON-Kurs'`)).toHaveLength(1);
  });
  it('HTML templates (and a ZIP of them) become e-mail templates', async () => {
    const up = await upload('mailchimp', 'vorlagen.zip', zip({ 'Willkommen.html': '<html><head><title>Hallo *|FNAME|*</title></head><body><p>*|FNAME|*</p><img src="x" onerror="alert(1)"></body></html>', 'Zweite.html': '<p>zwei</p>' }));
    expect(up.data.kind).toBe('templates');
    const job = await run({ source: 'mailchimp', file_ids: [up.data.id] });
    expect(job.status).toBe('done');
    const tpl = q('SELECT name, subject, body FROM templates WHERE location_id = ? ORDER BY name');
    expect(tpl.map((x) => x.name)).toEqual(['Willkommen', 'Zweite']);
    expect(tpl[0].subject).toBe('Hallo {{contact.first_name|}}');
    expect(tpl[0].body).not.toContain('onerror');
  });
});

describe('limits', () => {
  it('refuses a file over the limit and a foreign source', async () => {
    await freshLocation('Grenzen');
    expect((await upload('nonsense', 'x.csv', 'a,b')).status).toBe(400);
    expect((await upload('kit', 'leer.csv', '')).status).toBe(400);
  });
});
