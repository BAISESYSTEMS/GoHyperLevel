import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';

/**
 * The undo journal (docs/undo.md): every change to the main records is journaled before it happens,
 * "undo" puts the old state back in one transaction, conflicts are reported with a diff, an undo can be
 * undone, and nothing leaks across sub-accounts or past a person's rights.
 */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
});
afterAll(() => t.close());

const undoOf = (r: { headers: Headers }) => r.headers.get('x-undo-id');
const labelOf = (r: { headers: Headers }) => decodeURIComponent(r.headers.get('x-undo-label') ?? '');

describe('tasks', () => {
  it('complete → undo → reopened, with the toast headers, and redo', async () => {
    const task = (await t.api.post('/api/tasks', { title: 'Angebot schreiben' })).data;
    const done = await t.api.patch(`/api/tasks/${task.id}`, { done: true });
    expect(done.status).toBe(200);
    // The answer tells the web app what to offer as "Rückgängig".
    expect(labelOf(done as any)).toBe('Aufgabe „Angebot schreiben“ erledigt');
    const id = undoOf(done as any)!;
    expect(id).toBeTruthy();

    const r = await t.api.post(`/api/undo/${id}`, {});
    expect(r.status).toBe(200);
    expect(r.data.redo_id).toBeTruthy();
    const back = t.app.db.get('SELECT done, completed_at FROM tasks WHERE id = ?', task.id)!;
    expect(back.done).toBe(0);
    expect(back.completed_at).toBeNull();

    // Undo is undoable: redo completes it again.
    const redo = await t.api.post(`/api/undo/${r.data.redo_id}`, {});
    expect(redo.status).toBe(200);
    expect(t.app.db.get('SELECT done FROM tasks WHERE id = ?', task.id)!.done).toBe(1);
  });

  it('refuses a second undo of the same entry', async () => {
    const task = (await t.api.post('/api/tasks', { title: 'Nur einmal' })).data;
    const id = undoOf((await t.api.patch(`/api/tasks/${task.id}`, { done: true })) as any)!;
    expect((await t.api.post(`/api/undo/${id}`, {})).status).toBe(200);
    expect((await t.api.post(`/api/undo/${id}`, {})).status).toBe(409);
  });
});

describe('contacts', () => {
  it('delete with notes, tasks and a deal → undo → everything is back with the same ids', async () => {
    const c = (await t.api.post('/api/contacts', { first_name: 'Erika', last_name: 'Muster', email: 'erika@example.com', tags: ['kunde'] })).data;
    const n1 = (await t.api.post(`/api/contacts/${c.id}/notes`, { body: 'Erstgespräch' })).data;
    const n2 = (await t.api.post(`/api/contacts/${c.id}/notes`, { body: 'Rückruf' })).data;
    const task = (await t.api.post('/api/tasks', { title: 'Nachfassen', contact_id: c.id })).data;
    const pipe = (await t.api.get('/api/pipelines')).data[0];
    const deal = (await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: c.id, name: 'Paket', value: 12000 })).data;
    const before = {
      contact: t.app.db.get('SELECT * FROM contacts WHERE id = ?', c.id),
      notes: t.app.db.all('SELECT * FROM notes WHERE contact_id = ? ORDER BY id', c.id),
      tasks: t.app.db.all('SELECT * FROM tasks WHERE contact_id = ? ORDER BY id', c.id),
      deals: t.app.db.all('SELECT * FROM opportunities WHERE contact_id = ? ORDER BY id', c.id),
    };
    expect(before.notes).toHaveLength(2);

    const del = await t.api.del(`/api/contacts/${c.id}`);
    expect(del.status).toBe(200);
    expect(labelOf(del as any)).toBe('Kontakt „Erika Muster“ gelöscht');
    expect(t.app.db.get('SELECT id FROM contacts WHERE id = ?', c.id)).toBeUndefined();
    expect(t.app.db.get('SELECT id FROM notes WHERE id = ?', n1.id)).toBeUndefined();

    // It is in the trash with what comes back along.
    const trash = (await t.api.get('/api/undo/trash')).data;
    const item = trash.items.find((i: any) => i.entity_id === c.id);
    expect(item.kids_text).toContain('2 Notizen');
    expect(item.kids_text).toContain('1 Aufgabe');

    const r = await t.api.post(`/api/undo/${undoOf(del as any)}`, {});
    expect(r.status).toBe(200);
    expect(t.app.db.get('SELECT * FROM contacts WHERE id = ?', c.id)).toEqual(before.contact);
    expect(t.app.db.all('SELECT * FROM notes WHERE contact_id = ? ORDER BY id', c.id)).toEqual(before.notes);
    expect(t.app.db.all('SELECT * FROM tasks WHERE contact_id = ? ORDER BY id', c.id)).toEqual(before.tasks);
    expect(t.app.db.all('SELECT * FROM opportunities WHERE contact_id = ? ORDER BY id', c.id)).toEqual(before.deals);
    expect([n1.id, n2.id, task.id, deal.id].every(Boolean)).toBe(true);
    // The trash no longer lists it.
    expect((await t.api.get('/api/undo/trash')).data.items.find((i: any) => i.entity_id === c.id)).toBeUndefined();
  });

  it('puts back links that were only detached (appointments keep their contact)', async () => {
    const c = (await t.api.post('/api/contacts', { first_name: 'Hans', email: 'hans@example.com' })).data;
    const cal = (await t.api.post('/api/calendars', { name: 'Beratung' })).data;
    const start = new Date(Date.now() + 864e5).toISOString();
    const appt = t.app.db.get('SELECT 1 AS x')!;
    void appt;
    t.app.db.insert('appointments', { id: 'appt-detach', location_id: loc, calendar_id: cal.id, contact_id: c.id, title: 'Erstgespräch', start_at: start, end_at: new Date(Date.now() + 864e5 + 36e5).toISOString(), status: 'confirmed', source: 'test', manage_token: 'tok-detach', reminder_sent: 0, created_at: new Date().toISOString() });
    const del = await t.api.del(`/api/contacts/${c.id}`);
    expect(t.app.db.get('SELECT contact_id FROM appointments WHERE id = ?', 'appt-detach')!.contact_id).toBeNull();
    expect((await t.api.post(`/api/undo/${undoOf(del as any)}`, {})).status).toBe(200);
    expect(t.app.db.get('SELECT contact_id FROM appointments WHERE id = ?', 'appt-detach')!.contact_id).toBe(c.id);
  });

  it('tag add/remove is one entry each and undoes cleanly', async () => {
    const c = (await t.api.post('/api/contacts', { first_name: 'Tina', email: 'tina@example.com' })).data;
    const add = await t.api.post(`/api/contacts/${c.id}/tags`, { add: ['vip'] });
    expect(labelOf(add as any)).toBe('Kontakt „Tina“ Tag „vip“ hinzugefügt');
    expect(JSON.parse(t.app.db.get('SELECT tags FROM contacts WHERE id = ?', c.id)!.tags)).toEqual(['vip']);
    expect((await t.api.post(`/api/undo/${undoOf(add as any)}`, {})).status).toBe(200);
    expect(JSON.parse(t.app.db.get('SELECT tags FROM contacts WHERE id = ?', c.id)!.tags)).toEqual([]);
  });

  it('a bulk tag over many contacts is one group and undoes as one', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await t.api.post('/api/contacts', { first_name: `Bulk${i}`, email: `bulk${i}@example.com` })).data.id);
    const r = await t.api.post('/api/contacts/bulk', { ids, action: 'add_tag', tag: 'Messe' });
    expect(r.data.count).toBe(4);
    expect(labelOf(r as any)).toBe('4 Kontakte: Tag „Messe“ hinzugefügt');
    const list = (await t.api.get('/api/undo?limit=5')).data.items;
    const group = list.find((i: any) => i.id === undoOf(r as any) || i.label.startsWith('4 Kontakte'));
    expect(group.count).toBe(4);
    for (const id of ids) expect(JSON.parse(t.app.db.get('SELECT tags FROM contacts WHERE id = ?', id)!.tags)).toEqual(['Messe']);
    const u = await t.api.post(`/api/undo/${group.id}`, {});
    expect(u.status).toBe(200);
    expect(u.data.restored).toHaveLength(4);
    for (const id of ids) expect(JSON.parse(t.app.db.get('SELECT tags FROM contacts WHERE id = ?', id)!.tags)).toEqual([]);
  });
});

describe('deals', () => {
  it('a stage move undoes to the old stage, won/lost too', async () => {
    const c = (await t.api.post('/api/contacts', { first_name: 'Dora', email: 'dora@example.com' })).data;
    const pipe = (await t.api.get('/api/pipelines')).data[0];
    const [s0, s1] = pipe.stages;
    const deal = (await t.api.post('/api/opportunities', { pipeline_id: pipe.id, stage_id: s0.id, contact_id: c.id, name: 'Auftrag', value: 5000 })).data;
    const move = await t.api.patch(`/api/opportunities/${deal.id}`, { stage_id: s1.id });
    expect(labelOf(move as any)).toBe(`Deal „Auftrag“ → Stufe „${s1.name}“`);
    expect(t.app.db.get('SELECT stage_id FROM opportunities WHERE id = ?', deal.id)!.stage_id).toBe(s1.id);
    expect((await t.api.post(`/api/undo/${undoOf(move as any)}`, {})).status).toBe(200);
    expect(t.app.db.get('SELECT stage_id FROM opportunities WHERE id = ?', deal.id)!.stage_id).toBe(s0.id);

    const won = await t.api.patch(`/api/opportunities/${deal.id}`, { status: 'won' });
    expect(labelOf(won as any)).toBe('Deal „Auftrag“ als gewonnen markiert');
    expect((await t.api.post(`/api/undo/${undoOf(won as any)}`, {})).status).toBe(200);
    expect(t.app.db.get('SELECT status FROM opportunities WHERE id = ?', deal.id)!.status).toBe('open');
  });
});

describe('conflicts', () => {
  it('answers 409 with a diff when the record changed since, and lets the person force it', async () => {
    const task = (await t.api.post('/api/tasks', { title: 'Konflikt' })).data;
    const first = await t.api.patch(`/api/tasks/${task.id}`, { title: 'Konflikt 2' });
    await t.api.patch(`/api/tasks/${task.id}`, { title: 'Konflikt 3' });
    const r = await t.api.post(`/api/undo/${undoOf(first as any)}`, {});
    expect(r.status).toBe(409);
    expect(r.data.conflict).toBe(true);
    expect(r.data.diff).toEqual([expect.objectContaining({ label: 'Titel', entry: 'Konflikt 2', now: 'Konflikt 3', restore: 'Konflikt' })]);
    expect(t.app.db.get('SELECT title FROM tasks WHERE id = ?', task.id)!.title).toBe('Konflikt 3');
    const forced = await t.api.post(`/api/undo/${undoOf(first as any)}`, { force: true });
    expect(forced.status).toBe(200);
    expect(t.app.db.get('SELECT title FROM tasks WHERE id = ?', task.id)!.title).toBe('Konflikt');
  });

  it('does not count the same value saved again as a change', async () => {
    const task = (await t.api.post('/api/tasks', { title: 'Gleich' })).data;
    const r = await t.api.patch(`/api/tasks/${task.id}`, { title: 'Gleich' });
    expect(undoOf(r as any)).toBeNull();
  });
});

describe('edge cases', () => {
  it('a restore that cannot work (its contact is gone) answers 409 and changes nothing – the whole group is atomic', async () => {
    const c = (await t.api.post('/api/contacts', { first_name: 'Weg', email: 'weg@example.com' })).data;
    const linked = (await t.api.post('/api/tasks', { title: 'Hängt am Kontakt', contact_id: c.id })).data;
    const free = (await t.api.post('/api/tasks', { title: 'Frei' })).data;
    const bulk = await t.api.post('/api/pm/tasks/bulk', { ids: [linked.id, free.id], action: 'delete' });
    expect(bulk.status, JSON.stringify(bulk.data)).toBe(200);
    expect(labelOf(bulk as any)).toBe('2 Aufgaben gelöscht');
    const delContact = await t.api.del(`/api/contacts/${c.id}`);
    const r = await t.api.post(`/api/undo/${undoOf(bulk as any)}`, {});
    expect(r.status).toBe(409);
    expect(r.data.error).toContain('verknüpfter Datensatz');
    // nothing came back – not even the task that would have worked
    expect(t.app.db.get('SELECT id FROM tasks WHERE id = ?', free.id)).toBeUndefined();
    expect(t.app.db.get('SELECT undone_at FROM undo_entries WHERE id = ?', undoOf(bulk as any))!.undone_at).toBeNull();
    // restore the contact first, then the group works as one
    expect((await t.api.post(`/api/undo/${undoOf(delContact as any)}`, {})).status).toBe(200);
    const again = await t.api.post(`/api/undo/${undoOf(bulk as any)}`, {});
    expect(again.status).toBe(200);
    expect(again.data.restored).toHaveLength(2);
    expect(t.app.db.get('SELECT contact_id FROM tasks WHERE id = ?', linked.id)!.contact_id).toBe(c.id);
    expect(t.app.db.get('SELECT id FROM tasks WHERE id = ?', free.id)).toBeTruthy();
  });

  it('a delete that takes along too much is journaled but cannot be restored (and offers no toast)', async () => {
    const { LIMITS } = await import('../server/services/undo-core.js');
    const saved = LIMITS.rows;
    LIMITS.rows = 2;
    try {
      const c = (await t.api.post('/api/contacts', { first_name: 'Riesig', email: 'riesig@example.com' })).data;
      for (let i = 0; i < 4; i++) await t.api.post(`/api/contacts/${c.id}/notes`, { body: `Notiz ${i}` });
      const del = await t.api.del(`/api/contacts/${c.id}`);
      expect(del.status).toBe(200);
      expect(undoOf(del as any)).toBeNull();
      const entry = t.app.db.get<any>('SELECT id, restorable, reason FROM undo_entries WHERE entity_id = ?', c.id)!;
      expect(entry.restorable).toBe(0);
      expect(entry.reason).toContain('nicht im Papierkorb');
      const r = await t.api.post(`/api/undo/${entry.id}`, {});
      expect(r.status).toBe(422);
      // it shows in the Verlauf, with the reason and no restore button
      const item = (await t.api.get('/api/undo?limit=3')).data.items.find((i: any) => i.id === entry.id);
      expect(item).toMatchObject({ restorable: false, can_undo: false });
    } finally {
      LIMITS.rows = saved;
    }
  });

  it('the daily job is registered with the scheduler', async () => {
    const task = (await t.api.post('/api/tasks', { title: 'Alt für den Job' })).data;
    const id = undoOf((await t.api.patch(`/api/tasks/${task.id}`, { done: true })) as any);
    t.app.db.run('UPDATE undo_entries SET at = ? WHERE id = ?', new Date(Date.now() - 40 * 864e5).toISOString(), id);
    await t.app.tick();
    expect(t.app.db.get('SELECT id FROM undo_entries WHERE id = ?', id)).toBeUndefined();
  });

  it('keeps nothing when the write itself fails', async () => {
    const before = t.app.db.get<any>('SELECT COUNT(*) AS n FROM undo_entries')!.n;
    expect((await t.api.patch('/api/tasks/gibt-es-nicht', { done: true })).status).toBe(404);
    expect((await t.api.patch('/api/opportunities/gibt-es-nicht', { name: 'x' })).status).toBeGreaterThanOrEqual(400);
    expect(t.app.db.get<any>('SELECT COUNT(*) AS n FROM undo_entries')!.n).toBe(before);
  });
});
