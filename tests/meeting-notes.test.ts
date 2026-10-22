import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';

/**
 * The meeting-notes hook: what call intelligence (or a meeting recorder) calls to hang a summary on a deal – the deal is found by the
 * contact, a second delivery changes nothing, follow-ups can become tasks – and the same notes written by hand in the deal.
 */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let pipe: any;
let n = 0;
const attach = (input: Record<string, unknown>) => (t.app.services.attachCallSummary as (loc: string, i: any) => any)(loc, input);
const rows = (sql: string, ...p: any[]) => t.app.db.all<any>(sql, ...p);

async function contact(extra: Record<string, unknown> = {}) {
  const r = await t.api.post('/api/contacts', { first_name: `Person${++n}`, email: `person${n}@kunde.example`, ...extra });
  return r.data.id as string;
}
async function deal(contactId: string, extra: Record<string, unknown> = {}) {
  const r = await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: contactId, name: `Deal ${++n}`, value: 1000, ...extra });
  expect(r.status).toBe(200);
  return r.data.id as string;
}

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  pipe = (await t.api.post('/api/pipelines', { name: 'Vertrieb', stages: ['Neu', 'Angebot'] })).data;
}, 60_000);
afterAll(() => t.close());

describe('attachCallSummary', () => {
  it('hangs the summary on the contact’s open deal, with a note and a timeline entry', async () => {
    const c = await contact();
    const lost = await deal(c, { name: 'Alter Deal' });
    await t.api.patch(`/api/opportunities/${lost}`, { status: 'lost', lost_reason: 'Preis zu hoch' });
    const open = await deal(c, { name: 'Neuer Deal' });
    const events: any[] = [];
    t.app.events.on('meeting_note.added', (e) => void events.push(e.data));
    const r = attach({ contactId: c, summary: 'Interesse am Paket Plus. Angebot bis Freitag.', title: 'Erstgespräch', source: 'Anrufauswertung', externalId: 'call-1', durationSec: 1260, actionItems: ['Angebot senden', 'Termin für Demo'] });
    expect(r).toMatchObject({ dealId: open, duplicate: false, taskIds: [] });
    const note = rows('SELECT * FROM deal_meeting_notes WHERE id = ?', r.id)[0];
    expect(note).toMatchObject({ deal_id: open, contact_id: c, title: 'Erstgespräch', source: 'Anrufauswertung', duration_sec: 1260 });
    expect(JSON.parse(note.action_items)).toEqual(['Angebot senden', 'Termin für Demo']);
    // it reads on the deal …
    const list = (await t.api.get(`/api/opportunities/${open}/meeting-notes`)).data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: r.id, summary: 'Interesse am Paket Plus. Angebot bis Freitag.', action_items: ['Angebot senden', 'Termin für Demo'] });
    expect((await t.api.get(`/api/opportunities/${lost}/meeting-notes`)).data).toEqual([]);
    // … and on the contact page, like any note and activity
    const body = rows('SELECT body FROM notes WHERE id = ?', r.noteId)[0].body as string;
    expect(body).toContain('Erstgespräch (21 Min.)');
    expect(body).toContain('Interesse am Paket Plus.');
    expect(body).toContain('- Angebot senden');
    expect(rows(`SELECT summary FROM activities WHERE contact_id = ? AND type = 'call.summary'`, c)[0].summary).toMatch(/^Erstgespräch: Interesse am Paket Plus/);
    await t.app.events.flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ contactId: c, dealId: open, note: { title: 'Erstgespräch', source: 'Anrufauswertung' } });
  });

  it('a second delivery of the same call changes nothing', async () => {
    const c = await contact();
    await deal(c);
    const first = attach({ contactId: c, summary: 'Erste Fassung', source: 'Anrufauswertung', externalId: 'call-dup' });
    const again = attach({ contactId: c, summary: 'Erste Fassung', source: 'Anrufauswertung', externalId: 'call-dup' });
    expect(again).toMatchObject({ id: first.id, duplicate: true, taskIds: [] });
    expect(rows('SELECT 1 FROM deal_meeting_notes WHERE contact_id = ?', c)).toHaveLength(1);
    expect(rows('SELECT 1 FROM notes WHERE contact_id = ?', c)).toHaveLength(1);
    // the same id from another producer is another call
    expect(attach({ contactId: c, summary: 'Anderes System', source: 'Zoom', externalId: 'call-dup' }).duplicate).toBe(false);
  });

  it('an explicit deal wins; one of another contact is refused; without any open deal the note stays with the contact', async () => {
    const c = await contact();
    const first = await deal(c, { name: 'Erster' });
    await deal(c, { name: 'Zweiter' });
    expect(attach({ contactId: c, dealId: first, summary: 'Zum ersten' }).dealId).toBe(first);
    const other = await contact();
    const foreign = await deal(other);
    expect(() => attach({ contactId: c, dealId: foreign, summary: 'x' })).toThrow(/anderen Kontakt/);
    expect(() => attach({ contactId: c, dealId: 'gibtsnicht', summary: 'x' })).toThrow(/nicht gefunden/);
    expect(() => attach({ contactId: 'gibtsnicht', summary: 'x' })).toThrow(/Kontakt nicht gefunden/);
    expect(() => attach({ contactId: c, summary: '   ' })).toThrow(/Zusammenfassung/);
    const alone = await contact();
    const r = attach({ contactId: alone, summary: 'Noch kein Deal' });
    expect(r).toMatchObject({ dealId: null });
    expect(rows('SELECT deal_id FROM deal_meeting_notes WHERE id = ?', r.id)[0].deal_id).toBeNull();
    expect(rows('SELECT 1 FROM notes WHERE contact_id = ?', alone)).toHaveLength(1);
  });

  it('follow-ups become tasks of the deal’s owner when asked to', async () => {
    const owner = (await t.api.get('/api/me')).data.user.id;
    const c = await contact();
    await deal(c, { assigned_to: owner });
    const r = attach({ contactId: c, summary: 'Nächste Schritte', actionItems: ['Angebot senden', '  ', 'Referenzen schicken'], createTasks: true });
    expect(r.taskIds).toHaveLength(2);
    const tasks = rows('SELECT title, assigned_to, done, contact_id FROM tasks WHERE contact_id = ? ORDER BY title', c);
    expect(tasks).toEqual([{ title: 'Angebot senden', assigned_to: owner, done: 0, contact_id: c }, { title: 'Referenzen schicken', assigned_to: owner, done: 0, contact_id: c }]);
    // without the flag no tasks
    const c2 = await contact();
    await deal(c2);
    expect(attach({ contactId: c2, summary: 'Noch ein Gespräch', actionItems: ['Etwas tun'] }).taskIds).toEqual([]);
    expect(rows('SELECT 1 FROM tasks WHERE contact_id = ?', c2)).toHaveLength(0);
  });
});

describe('by hand and over the API', () => {
  it('a person writes a note in the deal; a key may deliver one; delete takes the contact note along', async () => {
    const c = await contact();
    const d = await deal(c);
    const r = await t.api.post('/api/meeting-notes', { contact_id: c, deal_id: d, title: 'Telefonat', summary: 'Kunde will im Januar starten.', action_items: ['Vertrag vorbereiten'], create_tasks: true });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.note).toMatchObject({ deal_id: d, title: 'Telefonat', source: '', created_by: expect.any(String) });
    expect(r.data.taskIds).toHaveLength(1);
    expect((await t.api.post('/api/meeting-notes', { contact_id: c, summary: '' })).status).toBe(400);
    expect((await t.api.post('/api/meeting-notes', { summary: 'x' })).status).toBe(400);
    expect((await t.api.post('/api/meeting-notes', { contact_id: c, deal_id: 'x', summary: 'x' })).status).toBe(404);
    expect((await t.api.del(`/api/meeting-notes/${r.data.id}`)).status).toBe(200);
    expect(rows('SELECT 1 FROM deal_meeting_notes WHERE id = ?', r.data.id)).toHaveLength(0);
    expect(rows('SELECT 1 FROM notes WHERE id = ?', r.data.noteId)).toHaveLength(0);
    expect((await t.api.del(`/api/meeting-notes/${r.data.id}`)).status).toBe(404);
    expect((await t.api.get('/api/opportunities/gibtsnicht/meeting-notes')).status).toBe(404);
  });

  it('record-level rules: notes follow the deal’s contact', async () => {
    const mk = async (email: string) => {
      const r = await t.api.post('/api/users', { email, password: 'passwort-123', name: email.split('@')[0], locations: [loc], permissions: ['contacts', 'opportunities'] });
      const login = await t.api.raw('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pghl': '1' }, body: JSON.stringify({ email, password: 'passwort-123' }) });
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
      const call = async (method: string, path: string, body?: unknown) => {
        const res = await t.api.raw(path, { method, headers: { 'content-type': 'application/json', 'x-pghl': '1', cookie, 'x-location-id': loc }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
      };
      return { id: r.data.id as string, call };
    };
    const lena = await mk('lena@example.com');
    const mine = await contact();
    const theirs = await contact();
    await t.api.patch(`/api/contacts/${mine}`, { assigned_to: lena.id });
    const dMine = await deal(mine, { assigned_to: lena.id });
    const dTheirs = await deal(theirs);
    const own = attach({ contactId: mine, summary: 'Mein Gespräch' });
    const foreign = attach({ contactId: theirs, summary: 'Fremdes Gespräch' });
    expect((await t.api.put('/api/sales/access', { enabled: true, unassigned: 'hide', rules: { default: { levels: { contacts: 'own', companies: 'all', deals: 'own', tasks: 'all', conversations: 'all' } } } })).status).toBe(200);
    try {
      expect((await lena.call('GET', `/api/opportunities/${dMine}/meeting-notes`)).data).toHaveLength(1);
      expect((await lena.call('GET', `/api/opportunities/${dTheirs}/meeting-notes`)).status).toBe(404);
      expect((await lena.call('POST', '/api/meeting-notes', { contact_id: theirs, summary: 'x' })).status).toBe(404);
      expect((await lena.call('DELETE', `/api/meeting-notes/${foreign.id}`)).status).toBe(404);
      expect((await lena.call('DELETE', `/api/meeting-notes/${own.id}`)).status).toBe(200);
    } finally {
      await t.api.put('/api/sales/access', { enabled: false });
    }
    expect(rows('SELECT 1 FROM deal_meeting_notes WHERE id = ?', foreign.id)).toHaveLength(1);
  });

  it('is there for AI tools and workflows', () => {
    expect((t.app.services.mcpTools as { name: string }[]).map((x) => x.name)).toContain('ghl_deal_meeting_note');
    expect(t.app.services.workflowTriggers).toContain('meeting_note.added');
    expect(typeof t.app.services.attachCallSummary).toBe('function');
  });
});
