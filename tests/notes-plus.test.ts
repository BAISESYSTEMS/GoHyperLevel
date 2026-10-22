import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';

/** Better notes (modules/notes-plus.ts): title, colour, pinning, sanitised Markdown, search, undo, the add_note step. */

let t: Awaited<ReturnType<typeof startTestApp>>;
let anna: any;
let ben: any;
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  anna = (await t.api.post('/api/contacts', { first_name: 'Anna', last_name: 'Alt', email: 'anna@example.com' })).data;
  ben = (await t.api.post('/api/contacts', { first_name: 'Ben', email: 'ben@example.com' })).data;
});
afterAll(() => t?.close());

const until = async (fn: () => boolean) => {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
};

describe('notes plus', () => {
  it('creates notes with title, colour and pin; Markdown comes back sanitised', async () => {
    const r = await t.api.post('/api/notes', { contact_id: anna.id, title: 'Erstgespräch', body: '**Budget** 5.000 €\n\n- Website\n- Logo\n\n<script>alert(1)</script>', color: 'yellow', pinned: true });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ title: 'Erstgespräch', color: 'yellow', pinned: true });
    expect(r.data.html).toContain('<strong>Budget</strong>');
    expect(r.data.html).toContain('<li>');
    expect(r.data.html).not.toContain('<script');
    expect((await t.api.post('/api/notes', { contact_id: anna.id, body: 'x', color: 'pink' })).status).toBe(400);
    expect((await t.api.post('/api/notes', { contact_id: anna.id, body: '' })).status).toBe(400);
    expect((await t.api.post('/api/notes', { contact_id: 'fremd', body: 'x' })).status).toBe(404);
    await t.api.post(`/api/contacts/${anna.id}/notes`, { body: 'Alte Notiz ohne Titel' });
  });

  it('lists pinned notes first and the contact page still sees every note', async () => {
    await t.api.post('/api/notes', { contact_id: anna.id, body: 'Neueste Notiz' });
    const list = (await t.api.get(`/api/notes?contact_id=${anna.id}`)).data as any[];
    expect(list[0].title).toBe('Erstgespräch');
    expect(list.slice(1).map((n) => n.body)).toEqual(['Neueste Notiz', 'Alte Notiz ohne Titel']);
    const page = (await t.api.get(`/api/contacts/${anna.id}`)).data;
    expect(page.notes).toHaveLength(3);
  });

  it('searches title, text and contact name over all notes', async () => {
    await t.api.post('/api/notes', { contact_id: ben.id, title: 'Rückruf', body: 'Budget klären' });
    expect(((await t.api.get('/api/notes?q=budget')).data as any[]).map((n) => n.first_name).sort()).toEqual(['Anna', 'Ben']);
    expect(((await t.api.get(`/api/notes?q=budget&contact_id=${ben.id}`)).data as any[]).map((n) => n.title)).toEqual(['Rückruf']);
    expect(((await t.api.get('/api/notes?q=Alt')).data as any[]).length).toBeGreaterThanOrEqual(1);
    expect(((await t.api.get('/api/notes?pinned=1')).data as any[]).map((n) => n.title)).toEqual(['Erstgespräch']);
  });

  it('edits a note; the undo journal takes it back', async () => {
    const note = ((await t.api.get(`/api/notes?contact_id=${anna.id}`)).data as any[])[0];
    const r = await t.api.patch(`/api/notes/${note.id}`, { body: 'Geändert', pinned: false, color: '' });
    expect(r.data).toMatchObject({ body: 'Geändert', pinned: false, color: '' });
    const undoId = r.headers.get('x-undo-id');
    expect(undoId).toBeTruthy();
    expect((await t.api.post(`/api/undo/${undoId}`, {})).status).toBe(200);
    expect(t.app.db.get('SELECT body, pinned, color FROM notes WHERE id = ?', note.id)).toMatchObject({ pinned: 1, color: 'yellow' });
    expect((await t.api.patch('/api/notes/nope', { body: 'x' })).status).toBe(404);
  });

  it('the workflow step add_note writes title, colour and pin', async () => {
    const wf = await t.api.post('/api/workflows', { name: 'Notiz', trigger: { type: 'manual', config: {} }, steps: [{ type: 'add_note', title: 'Von {{contact.first_name}}', body: 'Automatisch **wichtig**', color: 'red', pinned: true }] });
    expect(wf.status, JSON.stringify(wf.data)).toBe(200);
    await t.api.patch(`/api/workflows/${wf.data.id}`, { status: 'active' });
    expect((await t.api.post(`/api/workflows/${wf.data.id}/enroll`, { contact_ids: [ben.id] })).status).toBe(200);
    await until(() => !!t.app.db.get(`SELECT 1 FROM notes WHERE contact_id = ? AND color = 'red'`, ben.id));
    expect(t.app.db.get(`SELECT title, color, pinned, user_id FROM notes WHERE contact_id = ? AND body LIKE 'Automatisch%'`, ben.id)).toEqual({ title: 'Von Ben', color: 'red', pinned: 1, user_id: null });
  });

  it("never shows or changes another sub-account's notes", async () => {
    const mine = t.api.location;
    const note = ((await t.api.get(`/api/notes?contact_id=${anna.id}`)).data as any[])[0];
    const other = (await t.api.post('/api/locations', { name: 'Fremd' })).data.id as string;
    t.api.setLocation(other);
    expect((await t.api.get('/api/notes?q=Budget')).data).toEqual([]);
    expect((await t.api.patch(`/api/notes/${note.id}`, { body: 'gehackt' })).status).toBe(404);
    expect((await t.api.post('/api/notes', { contact_id: anna.id, body: 'x' })).status).toBe(404);
    t.api.setLocation(mine);
  });
});
