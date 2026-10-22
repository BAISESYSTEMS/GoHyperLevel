import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { client } from './security-fixtures.js';

/** The other records in the journal: companies (merge), pipelines, appointments, forms, funnels, invoices, products, tickets, tags, conversations, workflows, wiki, canvas. */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const undoId = (r: { headers: Headers }) => r.headers.get('x-undo-id')!;
const label = (r: { headers: Headers }) => decodeURIComponent(r.headers.get('x-undo-label') ?? '');
const notice = (r: { headers: Headers }) => decodeURIComponent(r.headers.get('x-undo-notice') ?? '');
const row = (sql: string, ...p: any[]) => t.app.db.get<any>(sql, ...p);
const undo = async (r: { headers: Headers }, body: unknown = {}) => {
  const id = undoId(r);
  expect(id, 'no undo id on the answer').toBeTruthy();
  const u = await t.api.post(`/api/undo/${id}`, body);
  expect(u.status, JSON.stringify(u.data)).toBe(200);
  return u;
};

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
});
afterAll(() => t.close());

describe('companies', () => {
  it('an edit and a delete come back, and a merge is undone with both companies and their links', async () => {
    const a = (await t.api.post('/api/companies', { name: 'Alpha GmbH', domain: 'alpha.example', city: 'Berlin' })).data;
    const b = (await t.api.post('/api/companies', { name: 'Beta AG', domain: 'beta.example', industry: 'Handel' })).data;
    const c = (await t.api.post('/api/contacts', { first_name: 'Karl', email: 'karl@beta.example' })).data;
    expect((await t.api.post('/api/associations', { from_type: 'contact', from_id: c.id, to_type: 'company', to_id: b.id })).status).toBeLessThan(300);
    await t.api.post(`/api/companies/${b.id}/notes`, { body: 'Alte Notiz bei Beta' });

    const edit = await t.api.patch(`/api/companies/${a.id}`, { city: 'Hamburg' });
    expect(label(edit as any)).toBe('Firma „Alpha GmbH“ geändert');
    await undo(edit);
    expect(row('SELECT city FROM companies WHERE id = ?', a.id).city).toBe('Berlin');

    const assoc = (id: string) => t.app.db.all("SELECT id FROM associations WHERE (a_type = 'company' AND a_id = ?) OR (b_type = 'company' AND b_id = ?) ORDER BY id", id, id).map((r: any) => r.id);
    const betaLinks = assoc(b.id);
    expect(betaLinks.length).toBeGreaterThan(0);
    const merge = await t.api.post(`/api/companies/${a.id}/merge`, { from_id: b.id });
    expect(merge.status).toBe(200);
    expect(label(merge as any)).toMatch(/^Firmen zusammengeführt/);
    expect(row('SELECT id FROM companies WHERE id = ?', b.id)).toBeUndefined();
    expect(assoc(a.id).length).toBeGreaterThan(0);
    expect(t.app.db.all("SELECT body FROM record_notes WHERE object_key = 'company' AND record_id = ?", a.id)).toHaveLength(1);

    await undo(merge);
    expect(row('SELECT name, industry FROM companies WHERE id = ?', b.id)).toMatchObject({ name: 'Beta AG', industry: 'Handel' });
    expect(row('SELECT name, domain FROM companies WHERE id = ?', a.id)).toMatchObject({ name: 'Alpha GmbH', domain: 'alpha.example' });
    expect(assoc(b.id)).toEqual(betaLinks);
    expect(assoc(a.id)).toEqual([]);
    expect(t.app.db.all("SELECT body FROM record_notes WHERE object_key = 'company' AND record_id = ?", b.id)).toHaveLength(1);
    expect(t.app.db.all("SELECT body FROM record_notes WHERE object_key = 'company' AND record_id = ?", a.id)).toHaveLength(0);

    const del = await t.api.del(`/api/companies/${b.id}`);
    expect(row('SELECT id FROM companies WHERE id = ?', b.id)).toBeUndefined();
    await undo(del);
    expect(row('SELECT name FROM companies WHERE id = ?', b.id)).toMatchObject({ name: 'Beta AG' });
    expect(assoc(b.id)).toEqual(betaLinks);
  });
});

describe('pipelines', () => {
  it('removing a stage moves deals to the first one – undo puts the stages and every deal back', async () => {
    const p = (await t.api.post('/api/pipelines', { name: 'Vertrieb 2', stages: ['Neu', 'Angebot', 'Gewonnen'] })).data;
    const [s0, s1] = p.stages;
    const c = (await t.api.post('/api/contacts', { first_name: 'Pia', email: 'pia@example.com' })).data;
    const deal = (await t.api.post('/api/opportunities', { pipeline_id: p.id, stage_id: s1.id, contact_id: c.id, name: 'Angebot Pia' })).data;
    const r = await t.api.patch(`/api/pipelines/${p.id}`, { stages: [s0, p.stages[2]] });
    expect(row('SELECT stage_id FROM opportunities WHERE id = ?', deal.id).stage_id).toBe(s0.id);
    await undo(r);
    expect(row('SELECT stage_id FROM opportunities WHERE id = ?', deal.id).stage_id).toBe(s1.id);
    expect(JSON.parse(row('SELECT stages FROM pipelines WHERE id = ?', p.id).stages).map((s: any) => s.name)).toEqual(['Neu', 'Angebot', 'Gewonnen']);

    const del = await t.api.del(`/api/pipelines/${p.id}`);
    expect(row('SELECT id FROM opportunities WHERE id = ?', deal.id)).toBeUndefined();
    await undo(del);
    expect(row('SELECT stage_id, name FROM opportunities WHERE id = ?', deal.id)).toMatchObject({ stage_id: s1.id, name: 'Angebot Pia' });
  });
});

describe('appointments', () => {
  it('cancelling says that notifications may be out, and undo makes the appointment confirmed again', async () => {
    const cal = (await t.api.post('/api/calendars', { name: 'Erstgespräch' })).data;
    const c = (await t.api.post('/api/contacts', { first_name: 'Anton', email: 'anton@example.com' })).data;
    const start = new Date(Date.now() + 2 * 864e5);
    t.app.db.insert('appointments', { id: 'appt-1', location_id: loc, calendar_id: cal.id, contact_id: c.id, title: 'Gespräch', start_at: start.toISOString(), end_at: new Date(+start + 36e5).toISOString(), status: 'confirmed', source: 'test', manage_token: 'm-1', reminder_sent: 0, created_at: new Date().toISOString() });
    const cancel = await t.api.patch('/api/appointments/appt-1', { status: 'cancelled' });
    expect(label(cancel as any)).toBe('Termin „Gespräch“ abgesagt');
    expect(notice(cancel as any)).toContain('Absage-Benachrichtigungen');
    const u = await undo(cancel);
    expect(u.data.notices[0]).toContain('Absage-Benachrichtigungen');
    expect(row('SELECT status FROM appointments WHERE id = ?', 'appt-1').status).toBe('confirmed');
    const del = await t.api.del('/api/appointments/appt-1');
    await undo(del);
    expect(row('SELECT title FROM appointments WHERE id = ?', 'appt-1').title).toBe('Gespräch');
  });
});

describe('products, forms, funnels, tags', () => {
  it('products and forms', async () => {
    const p = (await t.api.post('/api/products', { name: 'Beratung', price_cents: 9000 })).data;
    const edit = await t.api.patch(`/api/products/${p.id}`, { price_cents: 12000 });
    expect(label(edit as any)).toBe('Produkt „Beratung“ geändert');
    await undo(edit);
    expect(row('SELECT price_cents FROM products WHERE id = ?', p.id).price_cents).toBe(9000);
    await undo(await t.api.del(`/api/products/${p.id}`));
    expect(row('SELECT name FROM products WHERE id = ?', p.id).name).toBe('Beratung');

    const f = (await t.api.post('/api/forms', { name: 'Kontaktformular' })).data;
    const before = row('SELECT fields, settings FROM forms WHERE id = ?', f.id);
    const fe = await t.api.patch(`/api/forms/${f.id}`, { name: 'Neu benannt' });
    await undo(fe);
    expect(row('SELECT name FROM forms WHERE id = ?', f.id).name).toBe('Kontaktformular');
    await undo(await t.api.del(`/api/forms/${f.id}`));
    expect(row('SELECT fields, settings FROM forms WHERE id = ?', f.id)).toEqual(before);
  });

  it('a deleted funnel comes back with its pages; page edits of ten minutes are one entry', async () => {
    const fu = (await t.api.post('/api/funnels', { name: 'Webinar-Funnel', template: 'leadmagnet' })).data;
    const pages = t.app.db.all<any>('SELECT * FROM funnel_pages WHERE funnel_id = ? ORDER BY id', fu.id);
    expect(pages.length).toBeGreaterThan(0);
    const e1 = await t.api.patch(`/api/funnel-pages/${pages[0].id}`, { name: 'Erste Fassung' });
    const e2 = await t.api.patch(`/api/funnel-pages/${pages[0].id}`, { name: 'Zweite Fassung' });
    // The second autosave is the same entry – and does not pop a second toast.
    expect(e2.headers.get('x-undo-id')).toBeNull();
    await undo(e1);
    expect(row('SELECT name FROM funnel_pages WHERE id = ?', pages[0].id).name).toBe(pages[0].name);
    const del = await t.api.del(`/api/funnels/${fu.id}`);
    expect(t.app.db.all('SELECT id FROM funnel_pages WHERE funnel_id = ?', fu.id)).toHaveLength(0);
    await undo(del);
    expect(t.app.db.all<any>('SELECT * FROM funnel_pages WHERE funnel_id = ? ORDER BY id', fu.id).map((p) => p.id)).toEqual(pages.map((p: any) => p.id));
  });

  it('deleting a tag takes it off every contact – undo gives it back to the same contacts', async () => {
    const tag = (await t.api.post('/api/tags', { name: 'Stammkunde' })).data;
    const a = (await t.api.post('/api/contacts', { first_name: 'Eins', email: 'eins@example.com', tags: ['Stammkunde', 'x'] })).data;
    const b = (await t.api.post('/api/contacts', { first_name: 'Zwei', email: 'zwei@example.com', tags: ['Stammkunde'] })).data;
    const c = (await t.api.post('/api/contacts', { first_name: 'Drei', email: 'drei@example.com' })).data;
    const del = await t.api.del(`/api/tags/${tag.id}`);
    const tags = (id: string) => JSON.parse(row('SELECT tags FROM contacts WHERE id = ?', id).tags);
    expect(tags(a.id)).toEqual(['x']);
    await undo(del);
    expect(tags(a.id)).toEqual(['Stammkunde', 'x']);
    expect(tags(b.id)).toEqual(['Stammkunde']);
    expect(tags(c.id)).toEqual([]);
    expect(row('SELECT name FROM tags WHERE id = ?', tag.id).name).toBe('Stammkunde');
  });
});

describe('invoices', () => {
  it('drafts are undoable; a sent invoice is not journaled', async () => {
    const c = (await t.api.post('/api/contacts', { first_name: 'Rita', email: 'rita@example.com' })).data;
    const inv = (await t.api.post('/api/invoices', { contact_id: c.id, title: 'Entwurf', items: [{ name: 'Beratung', qty: 1, price_cents: 10000 }] })).data;
    const edit = await t.api.patch(`/api/invoices/${inv.id}`, { title: 'Geändert', items: [{ name: 'Beratung', qty: 2, price_cents: 10000 }] });
    expect(label(edit as any)).toBe('Rechnungsentwurf „Geändert“ geändert');
    await undo(edit);
    expect(row('SELECT title, total_cents FROM invoices WHERE id = ?', inv.id)).toMatchObject({ title: 'Entwurf', total_cents: inv.total_cents });
    const del = await t.api.del(`/api/invoices/${inv.id}`);
    await undo(del);
    expect(row('SELECT title FROM invoices WHERE id = ?', inv.id).title).toBe('Entwurf');

    // Once it is no draft any more, nothing is offered.
    t.app.db.run("UPDATE invoices SET status = 'sent' WHERE id = ?", inv.id);
    const later = await t.api.patch(`/api/invoices/${inv.id}`, { notes: 'Nachträglich' });
    expect(later.headers.get('x-undo-id')).toBeNull();
  });
});

describe('conversations, drafts and tickets', () => {
  it('a star is undoable but marking as read is not journaled; deleting a draft is', async () => {
    const c = (await t.api.post('/api/contacts', { first_name: 'Mara', email: 'mara@example.com' })).data;
    const now = new Date().toISOString();
    t.app.db.insert('conversations', { id: 'conv-1', location_id: loc, contact_id: c.id, unread: 1, starred: 0, last_message: 'Hallo', last_message_at: now, created_at: now });
    expect((await t.api.patch('/api/conversations/conv-1', { unread: false })).headers.get('x-undo-id')).toBeNull();
    const star = await t.api.patch('/api/conversations/conv-1', { starred: true });
    expect(label(star as any)).toBe('Konversation „Mara“ markiert');
    await undo(star);
    expect(row('SELECT starred FROM conversations WHERE id = ?', 'conv-1').starred).toBe(0);

    t.app.db.insert('messages', { id: 'msg-draft', location_id: loc, conversation_id: 'conv-1', contact_id: c.id, channel: 'email', direction: 'out', subject: 'Entwurf an Mara', body: 'Text', status: 'draft', created_at: now });
    const del = await t.api.del('/api/messages/msg-draft');
    expect(label(del as any)).toBe('Entwurf „Entwurf an Mara“ gelöscht');
    await undo(del);
    expect(row('SELECT body FROM messages WHERE id = ?', 'msg-draft').body).toBe('Text');
    // A message that was sent cannot be deleted at all.
    t.app.db.run("UPDATE messages SET status = 'sent' WHERE id = 'msg-draft'");
    expect((await t.api.del('/api/messages/msg-draft')).status).toBe(400);
  });

  it('closing a ticket is a status entry that undoes', async () => {
    const tk = (await t.api.post('/api/tickets', { subject: 'Drucker kaputt', contact_email: 'kunde@example.com' })).data;
    const closed = await t.api.patch(`/api/tickets/${tk.id}`, { status: 'closed' });
    expect(closed.status, JSON.stringify(closed.data)).toBe(200);
    expect(label(closed as any)).toMatch(/geschlossen$/);
    const kind = row('SELECT status_kind FROM tickets WHERE id = ?', tk.id).status_kind;
    expect(kind).toBe('closed');
    await undo(closed);
    expect(row('SELECT status_kind FROM tickets WHERE id = ?', tk.id).status_kind).not.toBe('closed');
  });
});

describe('workflows', () => {
  it('an edit points at the previous version; undo restores it and the history shows a version for it', async () => {
    const w = (await t.api.post('/api/workflows', { name: 'Willkommen', trigger: { type: 'contact.tag_added', config: {} }, steps: [{ type: 'add_tag', tags: ['a'] }] })).data;
    const versions = () => t.app.db.all<any>('SELECT version, note FROM workflow_versions WHERE workflow_id = ? ORDER BY version', w.id);
    expect(versions()).toHaveLength(1);
    const edit = await t.api.patch(`/api/workflows/${w.id}`, { steps: [{ type: 'add_tag', tags: ['a', 'b'] }, { type: 'add_note', body: 'Hallo' }] });
    expect(versions()).toHaveLength(2);
    // The entry is small: it names the version, it does not copy the steps.
    const stored = row('SELECT snap_before FROM undo_entries WHERE id = ?', undoId(edit as any)).snap_before;
    expect(stored).not.toContain('add_note');
    expect(JSON.parse(stored).row._version).toBe(1);
    await undo(edit);
    const now = row('SELECT steps FROM workflows WHERE id = ?', w.id);
    expect(JSON.parse(now.steps).map((s: any) => s.type)).toEqual(['add_tag']);
    expect(versions().at(-1).note).toBe('Wiederhergestellt (Rückgängig)');
    // Pause/activate is journaled too.
    const act = await t.api.patch(`/api/workflows/${w.id}`, { status: 'active' });
    expect(label(act as any)).toBe('Automation „Willkommen“ aktiviert');
    await undo(act);
    expect(row('SELECT status FROM workflows WHERE id = ?', w.id).status).toBe('draft');
    // Delete: the workflow, its versions come back.
    const del = await t.api.del(`/api/workflows/${w.id}`);
    expect(row('SELECT id FROM workflows WHERE id = ?', w.id)).toBeUndefined();
    await undo(del);
    expect(row('SELECT name FROM workflows WHERE id = ?', w.id).name).toBe('Willkommen');
    expect(versions().length).toBeGreaterThanOrEqual(2);
  });
});

describe('wiki', () => {
  it('edits of ten minutes are one entry that restores the old text through the wiki; trash goes through its restore', async () => {
    const space = (await t.api.post('/api/wiki/spaces', { name: 'Team' })).data;
    const page = (await t.api.post('/api/wiki/pages', { space_id: space.id, title: 'Handbuch', body: 'Erster Text' })).data;
    const e1 = await t.api.patch(`/api/wiki/pages/${page.id}`, { body: 'Zweiter Text' });
    expect(e1.status).toBe(200);
    await t.api.patch(`/api/wiki/pages/${page.id}`, { body: 'Dritter Text' });
    await new Promise((r) => setTimeout(r, 50));
    const list = (await t.api.get('/api/undo?limit=5')).data.items;
    const entry = list.find((i: any) => i.entity === 'wiki_page' && i.entity_id === page.id);
    expect(entry, JSON.stringify(list.map((i: any) => i.label))).toBeTruthy();
    expect(entry.label).toBe('Wiki-Seite „Handbuch“ geändert');
    expect((await t.api.post(`/api/undo/${entry.id}`, {})).status).toBe(200);
    expect(row('SELECT body FROM wiki_pages WHERE id = ?', page.id).body).toBe('Erster Text');
    // A new version records the restore.
    expect(t.app.db.all<any>('SELECT note FROM wiki_versions WHERE page_id = ?', page.id).some((v) => v.note === 'Wiederhergestellt (Rückgängig)')).toBe(true);

    const del = await t.api.del(`/api/wiki/pages/${page.id}`);
    expect(row('SELECT trashed_at FROM wiki_pages WHERE id = ?', page.id).trashed_at).toBeTruthy();
    await undo(del);
    expect(row('SELECT trashed_at FROM wiki_pages WHERE id = ?', page.id).trashed_at).toBeNull();
  });
});

describe('canvas', () => {
  it('an agent or key editing a board is undoable through a secured snapshot; people in the editor are not journaled', async () => {
    const board = (await t.api.post('/api/canvas', { name: 'Plan' })).data;
    const id = board.id ?? board.board?.id;
    expect((await t.api.post(`/api/canvas/${id}/elements`, { elements: [{ type: 'rect', x: 0, y: 0, w: 100, h: 60, text: 'Eins' }] })).headers.get('x-undo-id')).toBeNull();
    const k = (await t.api.post('/api/api-keys', { name: 'Agent-Schlüssel' })).data.key;
    const api = client(t.base, { authorization: `Bearer ${k}`, 'x-location-id': loc });
    const active = () => t.app.db.all<any>('SELECT id FROM canvas_elements WHERE board_id = ? AND deleted = 0', id).length;
    expect(active()).toBe(1);
    const r = await api('POST', `/api/canvas/${id}/elements`, { elements: [{ type: 'rect', x: 200, y: 0, w: 100, h: 60, text: 'Zwei' }, { type: 'rect', x: 400, y: 0, w: 100, h: 60, text: 'Drei' }] });
    expect(r.status, r.text).toBe(200);
    expect(active()).toBe(3);
    const uid = r.headers.get('x-undo-id')!;
    expect(uid).toBeTruthy();
    // The key itself can take it back.
    const u = await api('POST', `/api/undo/${uid}`, {});
    expect(u.status, u.text).toBe(200);
    expect(active()).toBe(1);
  });
});
