import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { client } from './security-fixtures.js';

/** GDPR: access (Art. 15) and erasure (Art. 17) of one contact across every module. */

let t: Awaited<ReturnType<typeof startTestApp>>;
let contactId = '';
let invoiceId = '';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  const form = (await t.api.post('/api/forms', { name: 'Anfrage', fields: [{ id: 'a', type: 'email', label: 'E-Mail', name: 'email', required: true }, { id: 'b', type: 'text', label: 'Vorname', name: 'first_name' }, { id: 'f', type: 'file', label: 'Foto', name: 'foto' }] })).data;
  await t.api.raw(`/api/public/forms/${form.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'dora@example.com', first_name: 'Dora', foto: { name: 'dora.png', data: PNG } }) });
  contactId = t.app.db.get(`SELECT id FROM contacts WHERE email = 'dora@example.com'`)!.id;
  await t.api.post(`/api/contacts/${contactId}/notes`, { body: 'Ruft nur vormittags an' });
  await t.api.post('/api/tasks', { title: 'Dora zurückrufen', contact_id: contactId });
  await t.api.post('/api/messages', { contact_id: contactId, channel: 'email', subject: 'Hallo', body: 'Hallo Dora' });
  await t.api.post('/api/tickets', { subject: 'Doras Problem', description: 'Geht nicht', contact_id: contactId });
  invoiceId = (await t.api.post('/api/invoices', { contact_id: contactId, items: [{ name: 'Beratung', qty: 1, price_cents: 1000 }] })).data.id;
  const program = (await t.api.post('/api/affiliates/programs', { name: 'Partner' })).data;
  await t.api.post('/api/affiliates', { program_id: program.id, name: 'Dora Partner', email: 'dora@example.com', iban: 'DE89 3704 0044 0532 0130 00' });
  t.app.db.run(`INSERT INTO activities (id, location_id, contact_id, type, summary, created_at) VALUES ('act-x', ?, ?, 'x', 'Dora hat geklickt', ?)`, t.api.location, contactId, new Date().toISOString());
});
afterAll(async () => t.close());

describe('GDPR', () => {
  it('exports everything stored about a contact, without tokens or secrets', async () => {
    const r = await t.api.raw(`/api/contacts/${contactId}/privacy-export`, { headers: { cookie: t.api.cookie, 'x-location-id': t.api.location } });
    expect(r.headers.get('content-disposition')).toMatch(/attachment; filename="dsgvo-auskunft-/);
    const out = await r.json();
    expect(out.contact.email).toBe('dora@example.com');
    for (const table of ['notes', 'tasks', 'messages', 'form_submissions', 'tickets', 'invoices', 'activities', 'affiliates (E-Mail)']) expect(Object.keys(out.data), table).toContain(table);
    // The uploaded file (as a list entry) and the history of the ticket the person opened.
    expect(out.data.form_files).toEqual([expect.objectContaining({ name: 'dora.png', mime: 'image/png' })]);
    expect(out.data.ticket_events?.length).toBeGreaterThan(0);
    expect(JSON.stringify(out)).not.toMatch(/public_token|token_hash|manage_token/);
    // The export is in the audit log.
    expect(t.app.db.get(`SELECT action FROM audit_log WHERE action LIKE 'export:contacts/:id/privacy-export'`)).toBeTruthy();
  });

  it('erases the contact everywhere, deletes uploaded files and keeps invoices unlinked', async () => {
    const dir = join(t.app.config.dataDir, 'form-files');
    expect(readdirSync(dir).length).toBe(1);
    expect((await t.api.post(`/api/contacts/${contactId}/erase`, { confirm: 'falsch@example.com' })).status).toBe(400);
    const r = await t.api.post(`/api/contacts/${contactId}/erase`, { confirm: 'Dora@Example.com' });
    expect(r.status).toBe(200);
    expect(r.data.erased).toMatchObject({ contacts: 1, tickets: 1, form_files: 1, affiliates: 1 });
    expect(r.data.erased.activities).toBeGreaterThanOrEqual(1);
    expect(r.data.retained).toContain('invoices');
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    for (const table of ['contacts', 'notes', 'tasks', 'messages', 'form_submissions', 'tickets', 'activities']) {
      expect(t.app.db.get(`SELECT COUNT(*) n FROM ${table} WHERE ${table === 'contacts' ? 'id' : 'contact_id'} = ?`, contactId)!.n, table).toBe(0);
    }
    expect(t.app.db.get('SELECT contact_id FROM invoices WHERE id = ?', invoiceId)).toEqual({ contact_id: null });
    const aff = t.app.db.get(`SELECT name, email, iban FROM affiliates`)!;
    expect(aff).toMatchObject({ name: 'Gelöscht (DSGVO)', iban: '' });
    expect(JSON.stringify(t.app.db.all('SELECT * FROM audit_log'))).not.toContain('dora@example.com');
  });

  it('MCP and the agency can export and erase by e-mail across sub-accounts', async () => {
    const other = (await t.api.post('/api/locations', { name: 'Zweitfirma' })).data.id;
    const admin = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1' });
    await admin('POST', '/api/contacts', { email: 'eva@example.com', first_name: 'Eva' }, { 'x-location-id': t.api.location });
    await admin('POST', '/api/contacts', { email: 'eva@example.com', first_name: 'Eva' }, { 'x-location-id': other });
    const exp = await admin('GET', '/api/agency/privacy/export?email=eva@example.com');
    expect(exp.data.contacts).toHaveLength(2);
    expect((await admin('POST', '/api/agency/privacy/erase', { email: 'eva@example.com', confirm: 'nope' })).status).toBe(400);
    const r = await admin('POST', '/api/agency/privacy/erase', { email: 'eva@example.com', confirm: 'eva@example.com' });
    expect(r.data.contacts).toBe(2);
    expect(t.app.db.get(`SELECT COUNT(*) n FROM contacts WHERE email = 'eva@example.com'`)!.n).toBe(0);

    // MCP with a sub-account key.
    const key = (await t.api.post('/api/api-keys', { name: 'mcp' })).data.key;
    const id = (await t.api.post('/api/contacts', { email: 'fritz@example.com' })).data.id;
    const mcp = client(t.base, { authorization: `Bearer ${key}` });
    const call = async (name: string, args: any) => (await mcp('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).data.result;
    expect(JSON.stringify(await call('ghl_contact_privacy_export', { contact_id: id }))).toContain('fritz@example.com');
    expect((await call('ghl_contact_erase', { contact_id: id, confirm: 'x' })).isError).toBe(true);
    expect((await call('ghl_contact_erase', { contact_id: id, confirm: 'fritz@example.com' })).isError).toBe(false);
    expect(t.app.db.get('SELECT id FROM contacts WHERE id = ?', id)).toBeUndefined();
  });

  it('deleting a contact the normal way (one or in bulk) also deletes the files whose rows go with it', async () => {
    const dir = t.app.config.dataDir;
    const at = new Date().toISOString();
    const group = (await t.api.post('/api/community/groups', { name: 'Gruppe' })).data.id;
    const withFiles = async (email: string, n: number) => {
      const id = (await t.api.post('/api/contacts', { email })).data.id as string;
      t.app.db.insert('community_videos', { id: `vid${n}0000000000000001`, location_id: t.api.location, group_id: group, contact_id: id, name: 'v.mp4', file: `vidfile${n}000000000001.mp4`, size: 1, received: 1, status: 'complete', created_at: at });
      t.app.db.insert('call_intel', { id: `intel${n}`, location_id: t.api.location, source: 'upload', contact_id: id, title: 'Gespräch', status: 'done', audio_file: `audio${n}0000000000001.mp3`, audio_bytes: 1, created_at: at });
      const files = [join(dir, 'community', 'videos', `vidfile${n}000000000001.mp4`), join(dir, 'call-intel', `audio${n}0000000000001.mp3`)];
      for (const f of files) {
        mkdirSync(join(f, '..'), { recursive: true });
        writeFileSync(f, 'x');
      }
      return { id, files };
    };
    const one = await withFiles('loesch1@example.com', 1);
    const two = await withFiles('loesch2@example.com', 2);
    expect((await t.api.del(`/api/contacts/${one.id}`)).status).toBe(200);
    expect((await t.api.post('/api/contacts/bulk', { action: 'delete', ids: [two.id] })).data.count).toBe(1);
    expect([...one.files, ...two.files].filter((f) => existsSync(f))).toEqual([]);
  });

  it('logs rights changes with what changed', async () => {
    const u = (await t.api.post('/api/users', { email: 'rights@example.com', password: 'passwort-1', locations: [] })).data;
    await t.api.patch(`/api/users/${u.id}`, { role: 'admin', permissions: ['contacts'] });
    const row = t.app.db.get(`SELECT summary FROM audit_log WHERE action = 'users.rights.update' AND entity_id = ?`, u.id)!;
    expect(row.summary).toMatch(/role, permissions.*Rolle: admin/);
  });
});
